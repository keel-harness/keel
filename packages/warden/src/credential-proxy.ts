import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { SandboxCredentialProxyConfig } from "./sandbox.js";
import { normalizeEgressGrantDomain } from "./egress-review.js";

// Env-var names + project-config path now live in `@keel/shared` (ADR-0071 P1-10); re-export
// to keep the warden's public surface unchanged.
import { CREDENTIAL_PROXY_CONFIG_ENV, CREDENTIAL_PROXY_PROJECT_CONFIG_ENV } from "@keel/shared";
export {
  CREDENTIAL_PROXY_CONFIG_ENV,
  CREDENTIAL_PROXY_PROJECT_CONFIG_ENV,
  CREDENTIAL_PROXY_PROJECT_CONFIG_PATH,
} from "@keel/shared";

export type CredentialProxySource =
  | { readonly kind: "env"; readonly name: string }
  | {
      readonly kind: "file";
      readonly path: string;
      /**
       * Present only on `project`-provenance file sources: the realpath'd workspace root the file must
       * stay inside. The read path re-checks containment against this at read time (not just parse
       * time), closing the TOCTOU where the pinned path becomes an out-of-workspace symlink after parse.
       */
      readonly workspaceConfinement?: string;
    }
  | {
      readonly kind: "command";
      readonly command: string;
      readonly args?: readonly string[];
    };

export type CredentialProxyPublicSource =
  | { readonly kind: "env"; readonly name: string }
  | { readonly kind: "file" }
  | { readonly kind: "command" };

export type CredentialProxyMode = "swap_on_access" | "placeholder";

export interface CredentialProxyRule {
  readonly id: string;
  readonly mode: CredentialProxyMode;
  readonly host: string;
  readonly scheme: string;
  readonly source: CredentialProxySource;
  readonly placeholderEnv?: string;
  readonly allowPlaintextInject?: boolean;
}

export interface CredentialProxyPublicSummary {
  readonly id: string;
  readonly mode: CredentialProxyMode;
  readonly host: string;
  readonly scheme: string;
  readonly source: CredentialProxyPublicSource;
  readonly placeholderEnv?: string;
  readonly allowPlaintextInject: boolean;
}

export interface CredentialProxyResolutionFailure {
  readonly rule: CredentialProxyPublicSummary;
  readonly reason: string;
}

export interface CredentialProxyCommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CredentialProxyResolveOptions {
  readonly readFile?: (path: string) => string | undefined;
  readonly runCommand?: (command: string, args: readonly string[]) => CredentialProxyCommandResult;
  readonly placeholderFactory?: (rule: CredentialProxyPublicSummary) => string;
}

/**
 * Where a credential-proxy config came from. `operator` config is set by a trusted operator through
 * `KEEL_WARDEN_CREDENTIAL_PROXY_RULES` and keeps ADR-0066's full source power (env/file/command,
 * `~`/absolute paths). `project` config is the workspace file `.keel/credential-proxy.json`. Governed
 * tools can no longer write that directory (the `workspace_keel_project_config` deny-write token), but
 * it can still arrive pre-committed in a trusted repo — so its sources are restricted to a
 * workspace-contained `file` and can neither execute code nor read warden-side secrets. This restriction
 * is the enforcement boundary; the deny-write token is defense in depth. Default is `operator`, so a
 * caller that does not opt into the restriction gets the historical behavior.
 */
export type CredentialProxyProvenance = "operator" | "project";

export interface CredentialProxyPathOptions {
  readonly workspaceRoot: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly provenance?: CredentialProxyProvenance;
}

export class CredentialProxyResolutionError extends Error {
  readonly failure: CredentialProxyResolutionFailure;

  constructor(failure: CredentialProxyResolutionFailure) {
    super(failure.reason);
    this.name = "CredentialProxyResolutionError";
    this.failure = failure;
  }
}

export class CredentialProxyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialProxyConfigError";
  }
}

const AUTH_SCHEME = /^[A-Za-z][A-Za-z0-9._~-]*$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PLACEHOLDER_VALUE = /^keelcred_[A-Za-z0-9._~-]+$/;
const SECRET_SOURCE_COMMAND_TIMEOUT_MS = 5_000;

function normalizeScheme(scheme: string): string {
  const normalized = scheme.trim();
  if (!AUTH_SCHEME.test(normalized)) throw new Error(`invalid authorization scheme: ${scheme}`);
  return normalized;
}

function validateEnvName(name: string, label: string): string {
  if (!ENV_NAME.test(name)) throw new Error(`invalid ${label}: ${name}`);
  return name;
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CredentialProxyConfigError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const known = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !known.has(key));
  if (unknown.length > 0) {
    throw new CredentialProxyConfigError(`${label} has unknown key(s): ${unknown.join(", ")}`);
  }
}

function stringField(value: Record<string, unknown>, field: string, label: string): string {
  const raw = value[field];
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new CredentialProxyConfigError(`${label}.${field} must be a non-empty string`);
  }
  return raw;
}

function boolField(value: Record<string, unknown>, field: string): boolean | undefined {
  const raw = value[field];
  if (raw === undefined) return undefined;
  if (typeof raw !== "boolean") {
    throw new CredentialProxyConfigError(`${field} must be a boolean`);
  }
  return raw;
}

function publicSource(source: CredentialProxySource): CredentialProxyPublicSource {
  switch (source.kind) {
    case "env":
      return { kind: "env", name: validateEnvName(source.name, "credential proxy env source") };
    case "file":
      if (source.path.trim() === "") throw new Error("credential proxy file source path is empty");
      return { kind: "file" };
    case "command":
      if (!isAbsolute(source.command)) {
        throw new Error("credential proxy command source must use an absolute command path");
      }
      for (const arg of source.args ?? []) {
        if (typeof arg !== "string") {
          throw new Error("credential proxy command source args must be strings");
        }
      }
      return { kind: "command" };
  }
}

function publicSummary(rule: CredentialProxyRule): CredentialProxyPublicSummary {
  const host = normalizeEgressGrantDomain(rule.host);
  const allowPlaintextInject = rule.allowPlaintextInject ?? false;
  try {
    const mode = rule.mode;
    if (mode !== "swap_on_access" && mode !== "placeholder") {
      throw new Error(`invalid credential proxy mode: ${String(mode)}`);
    }
    const placeholderEnv =
      mode === "placeholder"
        ? validateEnvName(
            rule.placeholderEnv ?? "",
            "credential proxy placeholder environment variable",
          )
        : rule.placeholderEnv === undefined
          ? undefined
          : validateEnvName(
              rule.placeholderEnv,
              "credential proxy placeholder environment variable",
            );
    if (mode === "placeholder" && placeholderEnv === undefined) {
      throw new Error("credential proxy placeholder mode requires placeholderEnv");
    }
    return {
      id: rule.id,
      mode,
      host,
      scheme: normalizeScheme(rule.scheme),
      source: publicSource(rule.source),
      ...(placeholderEnv === undefined ? {} : { placeholderEnv }),
      allowPlaintextInject,
    };
  } catch (error) {
    throw new CredentialProxyResolutionError({
      rule: {
        id: rule.id,
        mode: rule.mode,
        host,
        scheme: rule.scheme,
        source: sourcePublicSummaryForError(rule.source),
        ...(rule.placeholderEnv === undefined ? {} : { placeholderEnv: rule.placeholderEnv }),
        allowPlaintextInject,
      },
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

function sourcePublicSummaryForError(source: CredentialProxySource): CredentialProxyPublicSource {
  return source.kind === "env" ? { kind: "env", name: source.name } : { kind: source.kind };
}

function trimOneFinalLineBreak(value: string): string {
  return value.replace(/\r?\n$/u, "");
}

function nonEmptySecret(value: string, rule: CredentialProxyPublicSummary): string {
  const normalized = trimOneFinalLineBreak(value);
  if (normalized === "") {
    throw new CredentialProxyResolutionError({
      rule,
      reason: "credential proxy source resolved to an empty value",
    });
  }
  return normalized;
}

function defaultReadFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function defaultRunCommand(command: string, args: readonly string[]): CredentialProxyCommandResult {
  const result = spawnSync(command, [...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: SECRET_SOURCE_COMMAND_TIMEOUT_MS,
  });
  if (result.error !== undefined) return { status: null, stdout: "", stderr: "" };
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function sourceValue(
  rule: CredentialProxyRule,
  summary: CredentialProxyPublicSummary,
  env: NodeJS.ProcessEnv,
  options: CredentialProxyResolveOptions,
): string {
  switch (rule.source.kind) {
    case "env": {
      const value = env[rule.source.name];
      if (value === undefined || value === "") {
        throw new CredentialProxyResolutionError({
          rule: summary,
          reason: `credential proxy source ${rule.source.name} is unavailable`,
        });
      }
      return nonEmptySecret(value, summary);
    }
    case "file": {
      // For project-provenance sources, re-resolve symlinks and re-check workspace containment AT READ
      // TIME, then read the canonical path — so a symlink planted at the pinned path after parse cannot
      // read an out-of-workspace file (TOCTOU). Operator sources keep the historical direct read.
      // Documented limitation: the realpath check and the read are separate syscalls, so a sub-microsecond
      // swap of a parent component of the canonical path between them is not re-validated. It is
      // structurally impossible under `.keel` (deny-write) and requires winning a race against the
      // single-threaded, non-yielding warden on every egress read; fully closing it needs openat/O_NOFOLLOW
      // resolution the sync fs API cannot express.
      let readPath = rule.source.path;
      const confinement = rule.source.workspaceConfinement;
      if (confinement !== undefined) {
        let physical: string;
        try {
          physical = realpathSync(rule.source.path);
        } catch {
          throw new CredentialProxyResolutionError({
            rule: summary,
            reason: "credential proxy file source is unavailable",
          });
        }
        if (!isWithinWorkspace(physical, confinement)) {
          throw new CredentialProxyResolutionError({
            rule: summary,
            reason: "project credential proxy file source resolved outside the workspace",
          });
        }
        readPath = physical;
      }
      const value = (options.readFile ?? defaultReadFile)(readPath);
      if (value === undefined) {
        throw new CredentialProxyResolutionError({
          rule: summary,
          reason: "credential proxy file source is unavailable",
        });
      }
      return nonEmptySecret(value, summary);
    }
    case "command": {
      const result = (options.runCommand ?? defaultRunCommand)(rule.source.command, [
        ...(rule.source.args ?? []),
      ]);
      if (result.status !== 0) {
        throw new CredentialProxyResolutionError({
          rule: summary,
          reason: "credential proxy command source failed",
        });
      }
      return nonEmptySecret(result.stdout, summary);
    }
  }
}

function defaultPlaceholder(): string {
  return `keelcred_${randomBytes(18).toString("hex")}`;
}

function normalizePlaceholder(value: string, rule: CredentialProxyPublicSummary): string {
  if (!PLACEHOLDER_VALUE.test(value)) {
    throw new CredentialProxyResolutionError({
      rule,
      reason: "credential proxy placeholder factory produced an invalid placeholder",
    });
  }
  return value;
}

export function credentialProxyPublicSummary(
  rules: readonly CredentialProxyRule[] = [],
): CredentialProxyPublicSummary[] {
  return rules.map(publicSummary);
}

export function credentialProxyAllowedDomains(
  rules: readonly CredentialProxyRule[] = [],
): string[] {
  const domains: string[] = [];
  const seen = new Set<string>();
  for (const rule of rules) {
    const host = normalizeEgressGrantDomain(rule.host);
    if (seen.has(host)) continue;
    seen.add(host);
    domains.push(host);
  }
  return domains;
}

function mergeSandboxEnv(
  target: Record<string, string>,
  key: string,
  value: string,
  rule: CredentialProxyPublicSummary,
): void {
  const existing = target[key];
  if (existing !== undefined && existing !== value) {
    throw new CredentialProxyResolutionError({
      rule,
      reason: `credential proxy placeholder environment variable ${key} is configured more than once`,
    });
  }
  target[key] = value;
}

// `allowPlaintextInject` is a single property of the whole sandbox credential config, not a per-rule
// switch — so a mix of true/false rules would let one rule's `true` plaintext-inject every other
// rule's secret (including rules whose own `allowPlaintextInject` is false). The per-rule public
// summary implies isolation the config can't provide, so reject a mixed config fail-closed rather
// than silently OR-collapsing. An omitted flag normalizes to `false` (so omitted + explicit-false is
// uniform, not mixed).
function assertUniformPlaintextInject(
  rules: readonly { readonly allowPlaintextInject?: boolean }[],
): void {
  if (rules.length < 2) return;
  const first = rules[0]!.allowPlaintextInject ?? false;
  if (rules.some((rule) => (rule.allowPlaintextInject ?? false) !== first)) {
    throw new CredentialProxyConfigError(
      "credential proxy rules mix allowPlaintextInject true/false; the flag applies to the whole " +
        "sandbox credential config, not per rule, so every rule must agree (set it on all rules or " +
        "none) — rejected fail-closed to avoid plaintext-injecting a secret whose own rule forbids it",
    );
  }
}

export function resolveCredentialProxyRules(
  rules: readonly CredentialProxyRule[] = [],
  env: NodeJS.ProcessEnv = process.env,
  options: CredentialProxyResolveOptions = {},
): SandboxCredentialProxyConfig | undefined {
  if (rules.length === 0) return undefined;
  assertUniformPlaintextInject(rules);
  const summaries = credentialProxyPublicSummary(rules);
  const authorizationHeaders = [];
  const authorizationPlaceholders = [];
  const sandboxEnv: Record<string, string> = {};
  for (let i = 0; i < rules.length; i += 1) {
    const rule = rules[i]!;
    const summary = summaries[i]!;
    const secret = sourceValue(rule, summary, env, options);
    if (summary.mode === "swap_on_access") {
      authorizationHeaders.push({
        host: summary.host,
        scheme: summary.scheme,
        secret,
      });
    } else {
      const placeholder = normalizePlaceholder(
        options.placeholderFactory?.(summary) ?? defaultPlaceholder(),
        summary,
      );
      authorizationPlaceholders.push({
        host: summary.host,
        scheme: summary.scheme,
        placeholder,
        secret,
      });
      mergeSandboxEnv(sandboxEnv, summary.placeholderEnv!, placeholder, summary);
    }
  }
  return {
    ...(authorizationHeaders.length === 0 ? {} : { authorizationHeaders }),
    ...(authorizationPlaceholders.length === 0 ? {} : { authorizationPlaceholders }),
    ...(Object.keys(sandboxEnv).length === 0 ? {} : { sandboxEnv }),
    // Uniform across rules (asserted above) — represent the whole-config flag honestly.
    allowPlaintextInject: summaries[0]!.allowPlaintextInject,
  };
}

function isWithinWorkspace(resolved: string, workspaceRoot: string): boolean {
  const root = resolve(workspaceRoot);
  return resolved === root || resolved.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * Realpath the longest existing prefix of `resolved`, so symlink components are followed to their real
 * targets. A lexical containment check alone is defeated by an in-workspace symlink pointing outside
 * (`.keel/secrets/link -> ~/.ssh/id_rsa`); this returns the physical path the later `readFileSync` will
 * actually open. The file itself need not exist yet — we resolve its nearest existing ancestor.
 */
function realExistingPath(resolved: string): string {
  let current = resolved;
  const tail: string[] = [];
  // Walk up until an existing prefix is found (or we hit the filesystem root).
  for (;;) {
    try {
      const real = realpathSync(current);
      return tail.length === 0 ? real : join(real, ...tail.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolved; // reached root with nothing existing
      tail.push(basename(current));
      current = parent;
    }
  }
}

function resolveSourceFilePath(sourcePath: string, options: CredentialProxyPathOptions): string {
  const isProject = options.provenance === "project";
  if (sourcePath === "~" || sourcePath.startsWith("~/")) {
    if (isProject) {
      // A model-authored config must not reach the warden's HOME (e.g. ~/.ssh/id_rsa).
      throw new CredentialProxyConfigError(
        "project credential proxy file source must not use ~ home expansion",
      );
    }
    const home = options.env?.["HOME"] ?? process.env["HOME"];
    if (home === undefined || home.trim() === "") {
      throw new CredentialProxyConfigError("credential proxy file source uses ~ but HOME is unset");
    }
    return resolve(join(home, sourcePath === "~" ? "" : sourcePath.slice(2)));
  }
  const resolved = isAbsolute(sourcePath)
    ? resolve(sourcePath)
    : resolve(options.workspaceRoot, sourcePath);
  if (isProject) {
    // A model-authored config may only point at files the sandbox itself could read. Compare the
    // PHYSICAL path (symlinks followed) against the PHYSICAL workspace root, so an in-workspace symlink
    // cannot escape the workspace, and pin that physical path so the later read cannot be re-pointed
    // through the symlink (TOCTOU). Both sides are realpath-normalized so a symlinked workspace root
    // (e.g. macOS /tmp -> /private/tmp) does not cause a false rejection.
    const physicalRoot = realExistingPath(resolve(options.workspaceRoot));
    const physical = realExistingPath(resolved);
    if (!isWithinWorkspace(physical, physicalRoot)) {
      throw new CredentialProxyConfigError(
        "project credential proxy file source must resolve inside the workspace",
      );
    }
    return physical;
  }
  return resolved;
}

export function credentialProxyProtectedFilePaths(
  rules: readonly CredentialProxyRule[] = [],
  options: CredentialProxyPathOptions,
): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const rule of rules) {
    if (rule.source.kind !== "file") continue;
    const path = resolveSourceFilePath(rule.source.path, options);
    if (seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
  }
  return paths;
}

function parseSource(value: unknown, options: CredentialProxyPathOptions): CredentialProxySource {
  const source = objectRecord(value, "credential proxy source");
  const kind = source["kind"];
  const isProject = options.provenance === "project";
  if (isProject && (kind === "command" || kind === "env")) {
    // A model-authored (`project`) config must not execute code or read the warden's environment.
    // Only a workspace-contained `file` source is permitted; operator config keeps all three kinds.
    throw new CredentialProxyConfigError(
      `project credential proxy config may not use a ${kind} source; use a workspace file source`,
    );
  }
  if (kind === "env") {
    rejectUnknownKeys(source, ["kind", "name"], "credential proxy env source");
    return {
      kind,
      name: validateEnvName(
        stringField(source, "name", "credential proxy env source"),
        "credential proxy env source",
      ),
    };
  }
  if (kind === "file") {
    rejectUnknownKeys(source, ["kind", "path"], "credential proxy file source");
    return {
      kind,
      // Carry the confinement root on project file sources so the read path can re-check containment
      // at read time (TOCTOU): the pinned path could become an out-of-workspace symlink after parse.
      ...(isProject
        ? { workspaceConfinement: realExistingPath(resolve(options.workspaceRoot)) }
        : {}),
      path: resolveSourceFilePath(
        stringField(source, "path", "credential proxy file source"),
        options,
      ),
    };
  }
  if (kind === "command") {
    rejectUnknownKeys(source, ["kind", "command", "args"], "credential proxy command source");
    const command = stringField(source, "command", "credential proxy command source");
    if (!isAbsolute(command)) {
      throw new CredentialProxyConfigError(
        "credential proxy command source must use an absolute command path",
      );
    }
    const rawArgs = source["args"];
    if (rawArgs !== undefined && !Array.isArray(rawArgs)) {
      throw new CredentialProxyConfigError("credential proxy command source args must be an array");
    }
    const args = rawArgs?.map((arg) => {
      if (typeof arg !== "string") {
        throw new CredentialProxyConfigError(
          "credential proxy command source args must be strings",
        );
      }
      return arg;
    });
    return { kind, command, ...(args === undefined ? {} : { args }) };
  }
  throw new CredentialProxyConfigError(
    "credential proxy source kind must be env, file, or command",
  );
}

function parseRule(value: unknown, options: CredentialProxyPathOptions): CredentialProxyRule {
  const rule = objectRecord(value, "credential proxy rule");
  rejectUnknownKeys(
    rule,
    ["id", "mode", "host", "scheme", "source", "placeholderEnv", "allowPlaintextInject"],
    "credential proxy rule",
  );
  const mode = stringField(rule, "mode", "credential proxy rule");
  if (mode !== "swap_on_access" && mode !== "placeholder") {
    throw new CredentialProxyConfigError("credential proxy rule mode is invalid");
  }
  const allowPlaintextInject = boolField(rule, "allowPlaintextInject");
  const parsed: CredentialProxyRule = {
    id: stringField(rule, "id", "credential proxy rule"),
    mode,
    host: stringField(rule, "host", "credential proxy rule"),
    scheme: stringField(rule, "scheme", "credential proxy rule"),
    source: parseSource(rule["source"], options),
    ...(rule["placeholderEnv"] === undefined
      ? {}
      : {
          placeholderEnv: validateEnvName(
            stringField(rule, "placeholderEnv", "credential proxy rule"),
            "credential proxy placeholder environment variable",
          ),
        }),
    ...(allowPlaintextInject === undefined ? {} : { allowPlaintextInject }),
  };
  credentialProxyPublicSummary([parsed]);
  return parsed;
}

export function parseCredentialProxyConfig(
  raw: string,
  options: CredentialProxyPathOptions,
): CredentialProxyRule[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new CredentialProxyConfigError(
      `credential proxy config is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const root = objectRecord(parsed, "credential proxy config");
  rejectUnknownKeys(root, ["version", "rules"], "credential proxy config");
  if (root["version"] !== 1) {
    // Honest higher-version wording (ADR-0072 §4): a config this keel does not recognize was likely
    // written by a newer keel — say "upgrade", not a bare "must be 1".
    throw new CredentialProxyConfigError(
      `credential proxy config version ${JSON.stringify(root["version"])} is not supported by this keel (expected 1); it may have been written by a newer keel — upgrade keel to read it`,
    );
  }
  const rawRules = root["rules"];
  if (!Array.isArray(rawRules)) {
    throw new CredentialProxyConfigError("credential proxy config rules must be an array");
  }
  const rules = rawRules.map((entry) => parseRule(entry, options));
  // Fail fast at load: a mixed allowPlaintextInject config can never be honored per-rule.
  assertUniformPlaintextInject(rules);
  return rules;
}

export interface CredentialProxyEnvSelection {
  readonly workspaceRoot: string;
  readonly env: NodeJS.ProcessEnv;
}

/**
 * Select the active credential-proxy config from the warden's env and parse it under the correct
 * provenance. Operator config (`CREDENTIAL_PROXY_CONFIG_ENV`, set by a trusted operator) wins and is
 * parsed with full source power; otherwise the kernel-forwarded project config
 * (`CREDENTIAL_PROXY_PROJECT_CONFIG_ENV`, the model-writable workspace file) is parsed under the
 * restricted `project` provenance. Keeping the two channels distinct is the fix for the credential-proxy
 * RCE — the model can never launder a workspace command/env source into the operator channel.
 */
export function credentialProxyRulesFromEnvValues(
  selection: CredentialProxyEnvSelection,
): CredentialProxyRule[] | undefined {
  const operatorRaw = selection.env[CREDENTIAL_PROXY_CONFIG_ENV];
  if (operatorRaw !== undefined && operatorRaw.trim() !== "") {
    return parseCredentialProxyConfig(operatorRaw, {
      workspaceRoot: selection.workspaceRoot,
      env: selection.env,
      provenance: "operator",
    });
  }
  const projectRaw = selection.env[CREDENTIAL_PROXY_PROJECT_CONFIG_ENV];
  if (projectRaw !== undefined && projectRaw.trim() !== "") {
    return parseCredentialProxyConfig(projectRaw, {
      workspaceRoot: selection.workspaceRoot,
      env: selection.env,
      provenance: "project",
    });
  }
  return undefined;
}
