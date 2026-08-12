import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isIP } from "node:net";
import { basename, delimiter, dirname, isAbsolute, join } from "node:path";
import { canonicalExistingPath, isInsideCanonical } from "./path-util.js";

const MAX_CONFIGURATION_BYTES = 64 * 1024;
const MAX_CONFIGURATION_RECORDS = 1_024;
const MAX_MATCHING_HELPER_RECORDS = 8;
const MAX_HELPER_BYTES = 2_048;
const MAX_HELPER_ARGV = 16;
const MAX_HELPER_ARGUMENT_BYTES = 128;
const MAX_IDENTITY_FILE_BYTES = 256 * 1024 * 1024;
const DARWIN_ADMIN_GID = 80;
const FIXED_SYSTEM_DIRECTORIES = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"] as const;
const HELPER_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u;
const HELPER_ARGUMENT =
  /^(?:-{1,2})?[A-Za-z0-9][A-Za-z0-9._:@+,-]*(?:=[A-Za-z0-9][A-Za-z0-9._:@+,-]*)?$/u;
const INTERPRETER_OR_LOADER = new Set([
  ".",
  "bash",
  "command",
  "dash",
  "env",
  "fish",
  "ksh",
  "node",
  "nodejs",
  "osascript",
  "perl",
  "php",
  "python",
  "python2",
  "python3",
  "ruby",
  "sh",
  "source",
  "zsh",
]);
const SHELL_METACHARACTERS = new Set("$`|&;()<>#*?[]{}~");

export type GitCredentialAuthorityErrorCode =
  | "configuration_framing"
  | "configuration_origin"
  | "configuration_scope"
  | "environment_authority"
  | "executable_authority"
  | "helper_count"
  | "helper_syntax"
  | "include_authority";

export class GitCredentialAuthorityError extends Error {
  readonly code: GitCredentialAuthorityErrorCode;

  constructor(code: GitCredentialAuthorityErrorCode, message: string) {
    super(message);
    this.name = "GitCredentialAuthorityError";
    this.code = code;
  }
}

export interface GitCredentialAuthorityContext {
  readonly protocol: "https";
  readonly host: string;
  readonly path: string;
}

export interface GitCredentialAuthorityOptions {
  readonly gitExecutable: string;
  readonly inspectionCwd: string;
  readonly temporaryRoot: string;
  readonly workspaceRoot: string;
  readonly denyRoots: readonly string[];
  readonly env: NodeJS.ProcessEnv;
}

export interface ProvenanceFileIdentity {
  readonly canonicalPath: string;
  readonly dev: string;
  readonly ino: string;
  readonly uid: number;
  readonly gid: number;
  readonly mode: number;
  readonly size: string;
  readonly mtimeNs: string;
  readonly contentSha256: string;
  readonly parentDigest: string;
  readonly digest: string;
}

interface ProvenanceDirectoryIdentity {
  readonly canonicalPath: string;
  readonly dev: string;
  readonly ino: string;
  readonly uid: number;
  readonly gid: number;
  readonly mode: number;
  readonly mtimeNs: string;
  readonly digest: string;
}

export interface GitCredentialAuthorityBase {
  readonly effectiveUid: number;
  readonly workspaceRoot: string;
  readonly denyRoots: readonly string[];
  readonly inspectionCwd: string;
  readonly temporaryRoot: string;
  readonly home: ProvenanceDirectoryIdentity;
  readonly xdgConfigHome?: ProvenanceDirectoryIdentity;
  readonly gitExecutable: ProvenanceFileIdentity;
  readonly gitDirectory: ProvenanceDirectoryIdentity;
  readonly shell: ProvenanceFileIdentity;
  readonly fixedSystemDirectories: readonly ProvenanceDirectoryIdentity[];
  readonly rawPath: string;
  readonly inspectionEnv: Readonly<Record<string, string>>;
}

export type GitCredentialExecPathAuthority = ProvenanceDirectoryIdentity;

export interface ParsedGitCredentialHelperAuthority {
  readonly sourceKind: "bang" | "absolute" | "named";
  readonly storedValue: string;
  readonly argv: readonly string[];
  readonly executable: ProvenanceFileIdentity;
  readonly normalizedExecutionValue: string;
  readonly constructedPath: string;
}

export interface GitCredentialHelperAuthoritySnapshot {
  readonly gitExecutableDigest: string;
  readonly configurationDigest: string;
  readonly helperDigest: string;
  readonly helperCount: 1;
  readonly helper: ParsedGitCredentialHelperAuthority;
  readonly fillEnv: Readonly<Record<string, string>>;
}

interface ParsedConfigRecord {
  readonly ordinal: number;
  readonly scope: "system" | "global" | "local" | "worktree" | "command" | "unknown";
  readonly originRaw: string;
  readonly originPath: string;
  readonly key: string;
  readonly valueBytes: Buffer;
}

function sha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function fatalUtf8(value: Buffer, field: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    throw new GitCredentialAuthorityError(
      "configuration_framing",
      `Git credential ${field} is not valid UTF-8`,
    );
  }
}

function effectiveUid(): number {
  const uid = process.getuid?.();
  if (uid === undefined || !Number.isSafeInteger(uid) || uid < 0) {
    throw new GitCredentialAuthorityError(
      "environment_authority",
      "Git credential authority requires one POSIX operator identity",
    );
  }
  return uid;
}

function outsideBlockedRoots(
  spelling: string,
  canonical: string,
  workspaceRoot: string,
  denyRoots: readonly string[],
): boolean {
  const roots = [workspaceRoot, ...denyRoots];
  return roots.every(
    (root) => !isInsideCanonical(root, spelling) && !isInsideCanonical(root, canonical),
  );
}

function safeOwner(uid: number, owner: number): boolean {
  return owner === 0 || owner === uid;
}

function safeDirectoryMode(
  mode: number,
  owner: number,
  gid: number,
  uid: number,
  requireOperatorOwner: boolean,
): boolean {
  if ((mode & 0o002) !== 0) return false;
  if ((mode & 0o020) === 0) return true;
  return (
    !requireOperatorOwner &&
    process.platform === "darwin" &&
    owner === uid &&
    gid === DARWIN_ADMIN_GID
  );
}

function directoryIdentity(
  path: string,
  label: string,
  uid: number,
  workspaceRoot: string,
  denyRoots: readonly string[],
  requireOperatorOwner = false,
): ProvenanceDirectoryIdentity {
  let canonical: string;
  try {
    if (!isAbsolute(path)) throw new Error("relative");
    canonical = realpathSync(path);
    const stat = statSync(canonical, { bigint: true });
    const owner = Number(stat.uid);
    const gid = Number(stat.gid);
    const mode = Number(stat.mode);
    if (
      !stat.isDirectory() ||
      (requireOperatorOwner ? owner !== uid : !safeOwner(uid, owner)) ||
      !safeDirectoryMode(mode, owner, gid, uid, requireOperatorOwner) ||
      !outsideBlockedRoots(path, canonical, workspaceRoot, denyRoots)
    ) {
      throw new Error("unsafe");
    }
    const material = {
      canonicalPath: canonical,
      dev: String(stat.dev),
      ino: String(stat.ino),
      uid: owner,
      gid,
      mode,
      mtimeNs: String(stat.mtimeNs),
    };
    return { ...material, digest: sha256(JSON.stringify(material)) };
  } catch {
    throw new GitCredentialAuthorityError(
      "environment_authority",
      `Git credential ${label} directory authority is unsafe`,
    );
  }
}

function fileIdentity(
  path: string,
  label: string,
  uid: number,
  workspaceRoot: string,
  denyRoots: readonly string[],
  executable: boolean,
): ProvenanceFileIdentity {
  try {
    if (!isAbsolute(path)) throw new Error("relative");
    const canonical = realpathSync(path);
    if (!outsideBlockedRoots(path, canonical, workspaceRoot, denyRoots)) {
      throw new Error("blocked");
    }
    const stat = statSync(canonical, { bigint: true });
    const owner = Number(stat.uid);
    const mode = Number(stat.mode);
    if (
      !stat.isFile() ||
      !safeOwner(uid, owner) ||
      (mode & 0o022) !== 0 ||
      stat.size > BigInt(MAX_IDENTITY_FILE_BYTES)
    ) {
      throw new Error("unsafe");
    }
    if (executable) accessSync(canonical, constants.X_OK);
    const parent = directoryIdentity(
      dirname(canonical),
      `${label} parent`,
      uid,
      workspaceRoot,
      denyRoots,
    );
    const bytes = readFileSync(canonical);
    const after = statSync(canonical, { bigint: true });
    if (
      after.dev !== stat.dev ||
      after.ino !== stat.ino ||
      after.size !== stat.size ||
      after.mtimeNs !== stat.mtimeNs
    ) {
      throw new Error("changed");
    }
    const material = {
      canonicalPath: canonical,
      dev: String(stat.dev),
      ino: String(stat.ino),
      uid: owner,
      gid: Number(stat.gid),
      mode,
      size: String(stat.size),
      mtimeNs: String(stat.mtimeNs),
      contentSha256: sha256(bytes),
      parentDigest: parent.digest,
    };
    return { ...material, digest: sha256(JSON.stringify(material)) };
  } catch (error) {
    if (error instanceof GitCredentialAuthorityError) throw error;
    throw new GitCredentialAuthorityError(
      executable ? "executable_authority" : "configuration_origin",
      `Git credential ${label} file authority is unsafe`,
    );
  }
}

function uniqueDirectories(
  paths: readonly string[],
  uid: number,
  workspaceRoot: string,
  denyRoots: readonly string[],
): ProvenanceDirectoryIdentity[] {
  const seen = new Set<string>();
  const result: ProvenanceDirectoryIdentity[] = [];
  for (const path of paths) {
    if (!existsSync(path)) continue;
    const identity = directoryIdentity(path, "PATH", uid, workspaceRoot, denyRoots);
    if (seen.has(identity.canonicalPath)) continue;
    seen.add(identity.canonicalPath);
    result.push(identity);
  }
  return result;
}

export function prepareGitCredentialAuthority(
  options: GitCredentialAuthorityOptions,
): GitCredentialAuthorityBase {
  const uid = effectiveUid();
  let workspaceRoot: string;
  let denyRoots: string[];
  try {
    workspaceRoot = realpathSync(options.workspaceRoot);
    denyRoots = options.denyRoots.map((root) => canonicalExistingPath(root));
  } catch {
    throw new GitCredentialAuthorityError(
      "environment_authority",
      "Git credential workspace or deny-root authority is unavailable",
    );
  }
  const homeRaw = options.env["HOME"];
  if (homeRaw === undefined || homeRaw === "") {
    throw new GitCredentialAuthorityError(
      "environment_authority",
      "Git credential HOME authority is unavailable",
    );
  }
  const home = directoryIdentity(homeRaw, "HOME", uid, workspaceRoot, denyRoots, true);
  const xdgRaw = options.env["XDG_CONFIG_HOME"];
  const xdgConfigHome =
    xdgRaw === undefined || xdgRaw === ""
      ? undefined
      : directoryIdentity(xdgRaw, "XDG_CONFIG_HOME", uid, workspaceRoot, denyRoots, true);
  const gitExecutable = fileIdentity(
    options.gitExecutable,
    "Git executable",
    uid,
    workspaceRoot,
    denyRoots,
    true,
  );
  const gitDirectory = directoryIdentity(
    dirname(gitExecutable.canonicalPath),
    "Git executable parent",
    uid,
    workspaceRoot,
    denyRoots,
  );
  const shell = fileIdentity("/bin/sh", "fixed shell", uid, workspaceRoot, denyRoots, true);
  const inspectionCwd = directoryIdentity(
    options.inspectionCwd,
    "inspection cwd",
    uid,
    workspaceRoot,
    denyRoots,
  ).canonicalPath;
  const temporaryRoot = directoryIdentity(
    options.temporaryRoot,
    "temporary root",
    uid,
    workspaceRoot,
    denyRoots,
  ).canonicalPath;
  const fixedSystemDirectories = uniqueDirectories(
    FIXED_SYSTEM_DIRECTORIES,
    uid,
    workspaceRoot,
    denyRoots,
  );
  const inspectionPath = [gitDirectory, ...fixedSystemDirectories]
    .map((entry) => entry.canonicalPath)
    .filter((entry, index, values) => values.indexOf(entry) === index)
    .join(delimiter);
  const inspectionEnv: Record<string, string> = {
    HOME: home.canonicalPath,
    PATH: inspectionPath,
    SHELL: shell.canonicalPath,
    LANG: "C",
    LC_ALL: "C",
    TMPDIR: temporaryRoot,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/usr/bin/false",
    SSH_ASKPASS: "/usr/bin/false",
    GCM_INTERACTIVE: "never",
    GIT_CEILING_DIRECTORIES: inspectionCwd,
    GIT_DISCOVERY_ACROSS_FILESYSTEM: "0",
    GIT_TRACE: "0",
    GIT_TRACE_PACKET: "0",
    GIT_TRACE_CURL: "0",
    GIT_CURL_VERBOSE: "0",
  };
  if (xdgConfigHome !== undefined) {
    inspectionEnv["XDG_CONFIG_HOME"] = xdgConfigHome.canonicalPath;
  }
  return {
    effectiveUid: uid,
    workspaceRoot,
    denyRoots,
    inspectionCwd,
    temporaryRoot,
    home,
    ...(xdgConfigHome === undefined ? {} : { xdgConfigHome }),
    gitExecutable,
    gitDirectory,
    shell,
    fixedSystemDirectories,
    rawPath: options.env["PATH"] ?? "",
    inspectionEnv,
  };
}

export function resolveGitCredentialExecPath(
  base: GitCredentialAuthorityBase,
  output: Buffer,
): GitCredentialExecPathAuthority {
  const text = fatalUtf8(output, "exec path");
  if (
    !text.endsWith("\n") ||
    text.includes("\r") ||
    text.includes("\0") ||
    text.slice(0, -1).includes("\n") ||
    Buffer.byteLength(text, "utf8") > 1_025
  ) {
    throw new GitCredentialAuthorityError(
      "executable_authority",
      "Git credential exec-path framing is malformed",
    );
  }
  return directoryIdentity(
    text.slice(0, -1),
    "exec path",
    base.effectiveUid,
    base.workspaceRoot,
    base.denyRoots,
  );
}

function splitNulFields(output: Buffer): Buffer[] {
  if (output.length === 0 || output.length > MAX_CONFIGURATION_BYTES || output.at(-1) !== 0) {
    throw new GitCredentialAuthorityError(
      "configuration_framing",
      "Git credential configuration framing is malformed",
    );
  }
  const fields: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < output.length; index += 1) {
    if (output[index] !== 0) continue;
    fields.push(output.subarray(start, index));
    start = index + 1;
  }
  if (
    start !== output.length ||
    fields.length % 3 !== 0 ||
    fields.length / 3 > MAX_CONFIGURATION_RECORDS
  ) {
    throw new GitCredentialAuthorityError(
      "configuration_framing",
      "Git credential configuration records are malformed",
    );
  }
  return fields;
}

function parseConfigRecords(
  base: GitCredentialAuthorityBase,
  output: Buffer,
): ParsedConfigRecord[] {
  const fields = splitNulFields(output);
  const records: ParsedConfigRecord[] = [];
  for (let index = 0; index < fields.length; index += 3) {
    const scopeRaw = fatalUtf8(fields[index]!, "configuration scope");
    if (!/^(?:system|global|local|worktree|command|unknown)$/u.test(scopeRaw)) {
      throw new GitCredentialAuthorityError(
        "configuration_scope",
        "Git credential configuration scope is unsupported",
      );
    }
    const scope = scopeRaw as ParsedConfigRecord["scope"];
    if (scope === "local" || scope === "worktree" || scope === "command") {
      throw new GitCredentialAuthorityError(
        "configuration_scope",
        "Git credential project or command configuration is refused",
      );
    }
    const originRaw = fatalUtf8(fields[index + 1]!, "configuration origin");
    if (!originRaw.startsWith("file:")) {
      throw new GitCredentialAuthorityError(
        "configuration_origin",
        "Git credential configuration origin is not one ordinary file",
      );
    }
    const originPath = originRaw.slice("file:".length);
    if (!isAbsolute(originPath) || Buffer.byteLength(originPath, "utf8") > 2_048) {
      throw new GitCredentialAuthorityError(
        "configuration_origin",
        "Git credential configuration origin path is malformed",
      );
    }
    const keyValue = fields[index + 2]!;
    const newline = keyValue.indexOf(0x0a);
    if (newline <= 0 || newline > 1_024) {
      throw new GitCredentialAuthorityError(
        "configuration_framing",
        "Git credential configuration key/value framing is malformed",
      );
    }
    const key = fatalUtf8(keyValue.subarray(0, newline), "configuration key");
    records.push({
      ordinal: index / 3,
      scope,
      originRaw,
      originPath,
      key,
      valueBytes: keyValue.subarray(newline + 1),
    });
  }
  return records;
}

function decodeIncludeValue(
  base: GitCredentialAuthorityBase,
  record: ParsedConfigRecord,
  origin: ProvenanceFileIdentity,
): string {
  const value = fatalUtf8(record.valueBytes, "include path");
  if (
    value === "" ||
    Buffer.byteLength(value, "utf8") > 2_048 ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint <= 0x1f || codePoint === 0x7f;
    }) ||
    (value.startsWith("~") && !value.startsWith("~/"))
  ) {
    throw new GitCredentialAuthorityError(
      "include_authority",
      "Git credential include target is malformed",
    );
  }
  if (value.startsWith("~/")) return join(base.home.canonicalPath, value.slice(2));
  return isAbsolute(value) ? value : join(dirname(origin.canonicalPath), value);
}

function recordOriginIdentity(
  base: GitCredentialAuthorityBase,
  record: ParsedConfigRecord,
  cache: Map<string, ProvenanceFileIdentity>,
): ProvenanceFileIdentity {
  let identity = cache.get(record.originPath);
  if (identity === undefined) {
    identity = fileIdentity(
      record.originPath,
      "configuration origin",
      base.effectiveUid,
      base.workspaceRoot,
      base.denyRoots,
      false,
    );
    cache.set(record.originPath, identity);
  }
  return identity;
}

function validateIncludes(
  base: GitCredentialAuthorityBase,
  records: readonly ParsedConfigRecord[],
  cache: Map<string, ProvenanceFileIdentity>,
): ProvenanceFileIdentity[] {
  const contributingOrigins = new Set<string>();
  for (const record of records) {
    try {
      contributingOrigins.add(realpathSync(record.originPath));
    } catch {
      // An irrelevant safe-scope record supplies no helper or include authority. Its exact bytes
      // remain configuration-digest input, but a missing origin becomes fatal if consumed below.
    }
  }
  const includeTargets: ProvenanceFileIdentity[] = [];
  for (const record of records) {
    const key = record.key.toLowerCase();
    const unconditional = key === "include.path";
    const conditional = /^includeif\..+\.path$/u.test(key);
    if (!unconditional && !conditional) continue;
    const origin = recordOriginIdentity(base, record, cache);
    const target = decodeIncludeValue(base, record, origin);
    let canonical: string | undefined;
    try {
      canonical = realpathSync(target);
    } catch {
      if (unconditional) {
        throw new GitCredentialAuthorityError(
          "include_authority",
          "Git credential include target is unavailable",
        );
      }
    }
    if (unconditional || (canonical !== undefined && contributingOrigins.has(canonical))) {
      includeTargets.push(
        fileIdentity(
          target,
          "include target",
          base.effectiveUid,
          base.workspaceRoot,
          base.denyRoots,
          false,
        ),
      );
    }
  }
  return includeTargets;
}

function helperPatternMatches(
  key: string,
  context: GitCredentialAuthorityContext,
): boolean | undefined {
  const lower = key.toLowerCase();
  if (lower === "credential.helper") return true;
  if (!lower.startsWith("credential.") || !lower.endsWith(".helper")) return undefined;
  const pattern = key.slice("credential.".length, -".helper".length);
  const rawAuthority = pattern.slice("https://".length).split(/[/?#]/u, 1)[0];
  if (
    !pattern.startsWith("https://") ||
    pattern.includes("%") ||
    rawAuthority === undefined ||
    rawAuthority.includes(":")
  ) {
    throw new GitCredentialAuthorityError(
      "helper_syntax",
      "Git credential helper URL pattern is unsupported",
    );
  }
  let url: URL;
  try {
    url = new URL(pattern);
  } catch {
    throw new GitCredentialAuthorityError(
      "helper_syntax",
      "Git credential helper URL pattern is malformed",
    );
  }
  const hostLabels = url.hostname.split(".");
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    isIP(url.hostname) !== 0 ||
    hostLabels.some(
      (label) => label === "" || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label),
    )
  ) {
    throw new GitCredentialAuthorityError(
      "helper_syntax",
      "Git credential helper URL pattern is not one canonical HTTPS context",
    );
  }
  const patternPath = url.pathname.replace(/^\/+|\/+$/gu, "");
  if (
    patternPath !== "" &&
    (!/^[A-Za-z0-9._~/-]+$/u.test(patternPath) ||
      patternPath
        .split("/")
        .some((segment) => segment === "" || segment === "." || segment === ".."))
  ) {
    throw new GitCredentialAuthorityError(
      "helper_syntax",
      "Git credential helper URL path is malformed",
    );
  }
  return (
    url.hostname === context.host &&
    (patternPath === "" ||
      context.path === patternPath ||
      context.path.startsWith(`${patternPath}/`))
  );
}

function helperValue(record: ParsedConfigRecord): string {
  if (record.valueBytes.length > MAX_HELPER_BYTES) {
    throw new GitCredentialAuthorityError(
      "helper_syntax",
      "Git credential helper value exceeds its bound",
    );
  }
  const value = fatalUtf8(record.valueBytes, "helper value");
  if (value !== "" && !/^[\x20-\x7e]+$/u.test(value)) {
    throw new GitCredentialAuthorityError(
      "helper_syntax",
      "Git credential helper value contains unsupported bytes",
    );
  }
  return value;
}

function effectiveHelperRecord(
  records: readonly ParsedConfigRecord[],
  context: GitCredentialAuthorityContext,
): {
  readonly record: ParsedConfigRecord;
  readonly value: string;
  readonly reset?: ParsedConfigRecord;
} {
  const matching: { readonly record: ParsedConfigRecord; readonly value: string }[] = [];
  for (const record of records) {
    const matches = helperPatternMatches(record.key, context);
    if (matches !== true) continue;
    matching.push({ record, value: helperValue(record) });
  }
  if (matching.length > MAX_MATCHING_HELPER_RECORDS) {
    throw new GitCredentialAuthorityError(
      "helper_count",
      "Git credential helper record count exceeds its bound",
    );
  }
  let reset: ParsedConfigRecord | undefined;
  let effective: { readonly record: ParsedConfigRecord; readonly value: string }[] = [];
  for (const item of matching) {
    if (item.value === "") {
      reset = item.record;
      effective = [];
    } else {
      effective.push(item);
    }
  }
  const acceptedScope = (record: ParsedConfigRecord): boolean =>
    record.scope === "system" || record.scope === "global";
  if (reset !== undefined && !acceptedScope(reset)) {
    throw new GitCredentialAuthorityError(
      "configuration_scope",
      "Git credential helper reset is not system/global authority",
    );
  }
  if (effective.length !== 1 || !acceptedScope(effective[0]!.record)) {
    throw new GitCredentialAuthorityError(
      "helper_count",
      "Git credential helper requires exactly one effective system/global helper",
    );
  }
  return { ...effective[0]!, ...(reset === undefined ? {} : { reset }) };
}

function parseSimpleCommand(value: string): {
  readonly sourceKind: ParsedGitCredentialHelperAuthority["sourceKind"];
  readonly argv: readonly string[];
} {
  if (value === "" || value.trim() !== value) {
    throw new GitCredentialAuthorityError(
      "helper_syntax",
      "Git credential helper command is empty or ambiguously spaced",
    );
  }
  const sourceKind = value.startsWith("!") ? "bang" : value.startsWith("/") ? "absolute" : "named";
  const source = sourceKind === "bang" ? value.slice(1) : value;
  if (source === "" || source.trim() !== source) {
    throw new GitCredentialAuthorityError(
      "helper_syntax",
      "Git credential helper command is empty or ambiguously spaced",
    );
  }
  const argv: string[] = [];
  let token = "";
  let tokenStarted = false;
  let state: "unquoted" | "single" | "double" | "escape-unquoted" | "escape-double" = "unquoted";
  const finishToken = (): void => {
    if (!tokenStarted) return;
    argv.push(token);
    token = "";
    tokenStarted = false;
  };
  for (const character of source) {
    if (state === "single") {
      if (character === "'") state = "unquoted";
      else token += character;
      continue;
    }
    if (state === "double") {
      if (character === '"') state = "unquoted";
      else if (character === "\\") state = "escape-double";
      else if (character === "$" || character === "`") {
        throw new GitCredentialAuthorityError(
          "helper_syntax",
          "Git credential helper expansion is refused",
        );
      } else token += character;
      continue;
    }
    if (state === "escape-unquoted" || state === "escape-double") {
      token += character;
      state = state === "escape-double" ? "double" : "unquoted";
      continue;
    }
    if (character === " ") {
      finishToken();
      continue;
    }
    tokenStarted = true;
    if (character === "'") state = "single";
    else if (character === '"') state = "double";
    else if (character === "\\") state = "escape-unquoted";
    else if (SHELL_METACHARACTERS.has(character)) {
      throw new GitCredentialAuthorityError(
        "helper_syntax",
        "Git credential helper compound shell syntax is refused",
      );
    } else token += character;
  }
  if (state !== "unquoted") {
    throw new GitCredentialAuthorityError(
      "helper_syntax",
      "Git credential helper quoting is unterminated",
    );
  }
  finishToken();
  if (argv.length === 0 || argv.length > MAX_HELPER_ARGV || argv.some((arg) => arg === "")) {
    throw new GitCredentialAuthorityError(
      "helper_syntax",
      "Git credential helper argv is outside its bound",
    );
  }
  const executable = argv[0]!;
  if (sourceKind === "named") {
    if (!HELPER_NAME.test(executable)) {
      throw new GitCredentialAuthorityError(
        "helper_syntax",
        "Git credential named helper is malformed",
      );
    }
  } else if (isAbsolute(executable)) {
    if (!/^\/[A-Za-z0-9/._+@%:,= -]+$/u.test(executable)) {
      throw new GitCredentialAuthorityError(
        "helper_syntax",
        "Git credential absolute helper path is malformed",
      );
    }
  } else if (sourceKind === "absolute" || !HELPER_NAME.test(executable)) {
    throw new GitCredentialAuthorityError(
      "helper_syntax",
      "Git credential helper executable is malformed",
    );
  }
  if (INTERPRETER_OR_LOADER.has(basename(executable).toLowerCase())) {
    throw new GitCredentialAuthorityError(
      "helper_syntax",
      "Git credential interpreter or loader helper is refused",
    );
  }
  for (const argument of argv.slice(1)) {
    if (
      Buffer.byteLength(argument, "utf8") > MAX_HELPER_ARGUMENT_BYTES ||
      !HELPER_ARGUMENT.test(argument) ||
      argument === "." ||
      argument === ".." ||
      ((!argument.startsWith("-") || argument.startsWith("---")) && argument.includes("=")) ||
      /^(?:-c|-e|--eval|--execute)$/u.test(argument)
    ) {
      throw new GitCredentialAuthorityError(
        "helper_syntax",
        "Git credential helper argument is outside the fixed grammar",
      );
    }
  }
  return { sourceKind, argv };
}

function discoveryDirectories(
  base: GitCredentialAuthorityBase,
  gitExecPath: GitCredentialExecPathAuthority,
): string[] {
  const result = [
    gitExecPath.canonicalPath,
    base.gitDirectory.canonicalPath,
    ...base.fixedSystemDirectories.map((entry) => entry.canonicalPath),
  ];
  for (const entry of base.rawPath.split(delimiter)) {
    if (entry === "" || !isAbsolute(entry)) continue;
    if ([base.workspaceRoot, ...base.denyRoots].some((root) => isInsideCanonical(root, entry))) {
      continue;
    }
    try {
      const canonical = realpathSync(entry);
      if (!statSync(canonical).isDirectory()) continue;
      result.push(canonical);
    } catch {
      // Ambient PATH is discovery input only. Unsafe or missing entries supply no authority.
    }
  }
  return result.filter((entry, index, values) => values.indexOf(entry) === index);
}

function resolveHelperExecutable(
  base: GitCredentialAuthorityBase,
  gitExecPath: GitCredentialExecPathAuthority,
  sourceKind: ParsedGitCredentialHelperAuthority["sourceKind"],
  requested: string,
): ProvenanceFileIdentity {
  if (isAbsolute(requested)) {
    return fileIdentity(
      requested,
      "helper executable",
      base.effectiveUid,
      base.workspaceRoot,
      base.denyRoots,
      true,
    );
  }
  const executableName = sourceKind === "named" ? `git-credential-${requested}` : requested;
  for (const directory of discoveryDirectories(base, gitExecPath)) {
    const spelling = join(directory, executableName);
    try {
      const identity = fileIdentity(
        spelling,
        "helper executable",
        base.effectiveUid,
        base.workspaceRoot,
        base.denyRoots,
        true,
      );
      if (basename(identity.canonicalPath) !== executableName) continue;
      return identity;
    } catch {
      // Continue only across bounded discovery candidates; no candidate is execution authority yet.
    }
  }
  throw new GitCredentialAuthorityError(
    "executable_authority",
    "Git credential helper executable is unavailable",
  );
}

function quoteExecutable(path: string): string {
  return `'${path.replaceAll("'", "'\\''")}'`;
}

function createHelperAuthority(
  base: GitCredentialAuthorityBase,
  gitExecPath: GitCredentialExecPathAuthority,
  storedValue: string,
): ParsedGitCredentialHelperAuthority {
  const parsed = parseSimpleCommand(storedValue);
  const executable = resolveHelperExecutable(base, gitExecPath, parsed.sourceKind, parsed.argv[0]!);
  const normalizedExecutionValue = `!${[
    quoteExecutable(executable.canonicalPath),
    ...parsed.argv.slice(1),
  ].join(" ")}`;
  const pathEntries = [
    base.gitDirectory.canonicalPath,
    gitExecPath.canonicalPath,
    ...base.fixedSystemDirectories.map((entry) => entry.canonicalPath),
    dirname(executable.canonicalPath),
  ].filter((entry, index, values) => values.indexOf(entry) === index);
  return {
    sourceKind: parsed.sourceKind,
    storedValue,
    argv: parsed.argv,
    executable,
    normalizedExecutionValue,
    constructedPath: pathEntries.join(delimiter),
  };
}

export function inspectGitCredentialHelperAuthority(options: {
  readonly base: GitCredentialAuthorityBase;
  readonly gitExecPath: GitCredentialExecPathAuthority;
  readonly configurationOutput: Buffer;
  readonly context: GitCredentialAuthorityContext;
}): GitCredentialHelperAuthoritySnapshot {
  const records = parseConfigRecords(options.base, options.configurationOutput);
  const originCache = new Map<string, ProvenanceFileIdentity>();
  const includeTargets = validateIncludes(options.base, records, originCache);
  for (const record of records) {
    if (helperPatternMatches(record.key, options.context) === true) {
      recordOriginIdentity(options.base, record, originCache);
    }
  }
  const effective = effectiveHelperRecord(records, options.context);
  const helper = createHelperAuthority(options.base, options.gitExecPath, effective.value);
  const originIdentities = [
    ...new Map(
      [...originCache.values(), ...includeTargets].map((origin) => [origin.digest, origin]),
    ).values(),
  ]
    .map((origin) => origin.digest)
    .sort();
  const matchingRecords = records
    .filter((record) => helperPatternMatches(record.key, options.context) === true)
    .map((record) => ({
      ordinal: record.ordinal,
      scope: record.scope,
      origin: recordOriginIdentity(options.base, record, originCache).digest,
      key: record.key,
      valueSha256: sha256(record.valueBytes),
    }));
  const helperMaterial = {
    matchingRecords,
    originIdentities,
    gitExecutable: options.base.gitExecutable.digest,
    gitExecPath: options.gitExecPath.digest,
    gitDirectory: options.base.gitDirectory.digest,
    shell: options.base.shell.digest,
    home: options.base.home.digest,
    xdgConfigHome: options.base.xdgConfigHome?.digest ?? null,
    rawPath: options.base.rawPath,
    fixedSystemDirectories: options.base.fixedSystemDirectories.map((entry) => entry.digest),
    storedValue: helper.storedValue,
    argv: helper.argv,
    executable: helper.executable.digest,
    normalizedExecutionValue: helper.normalizedExecutionValue,
    constructedPath: helper.constructedPath,
  };
  const fillEnv: Record<string, string> = {
    ...options.base.inspectionEnv,
    PATH: helper.constructedPath,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  return {
    gitExecutableDigest: options.base.gitExecutable.digest,
    configurationDigest: sha256(options.configurationOutput),
    helperDigest: sha256(JSON.stringify(helperMaterial)),
    helperCount: 1,
    helper,
    fillEnv,
  };
}
