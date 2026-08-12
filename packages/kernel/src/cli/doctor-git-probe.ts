import { execFileSync, spawnSync } from "node:child_process";
import { accessSync, constants, lstatSync, realpathSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, relative } from "node:path";
import { parseJsonRejectingDuplicateKeys, supportedGitPushVersion } from "@keel/shared";

const INTERNAL_GIT_CREDENTIAL_DOCTOR_ENV = "KEEL_INTERNAL_GIT_CREDENTIAL_DOCTOR_V1";
const GIT_CREDENTIAL_DOCTOR_REQUEST_ENV = "KEEL_GIT_CREDENTIAL_DOCTOR_REQUEST_B64";

export interface GatherDoctorGitProbeOptions {
  readonly workspaceRoot: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly wardenStart?: {
    readonly command: string;
    readonly args: readonly string[];
    readonly env?: NodeJS.ProcessEnv;
  };
}

export interface DoctorGitProbe {
  readonly gitVersionRaw: string | null;
  readonly gitRemoteUrlRaw: string | null;
  readonly gitCredentialHelperConfigured: boolean;
  readonly gitCredentialHelperAuthorityIssue?: {
    readonly detail: string;
    readonly fix: string;
  };
}

function oneLine(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value !== "" &&
    Buffer.byteLength(value, "utf8") <= 1_024 &&
    !/[\r\n\u2028\u2029]/u.test(value)
  );
}

function credentialAuthorityProbe(
  start: NonNullable<GatherDoctorGitProbeOptions["wardenStart"]>,
  workspaceRoot: string,
  remoteUrl: string,
  env: NodeJS.ProcessEnv,
): { readonly configured: boolean; readonly detail?: string; readonly fix?: string } {
  try {
    const encoded = Buffer.from(JSON.stringify({ workspaceRoot, remoteUrl }), "utf8").toString(
      "base64",
    );
    const child = spawnSync(start.command, [...start.args], {
      cwd: workspaceRoot,
      env: {
        ...env,
        ...start.env,
        [INTERNAL_GIT_CREDENTIAL_DOCTOR_ENV]: "1",
        [GIT_CREDENTIAL_DOCTOR_REQUEST_ENV]: encoded,
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
      maxBuffer: 8 * 1_024,
    });
    if (
      child.error !== undefined ||
      child.signal !== null ||
      child.status !== 0 ||
      child.stderr !== ""
    ) {
      throw new Error("Warden credential doctor process failed");
    }
    const lines = child.stdout.trimEnd().split(/\r?\n/u);
    if (lines.length !== 1 || lines[0] === "") throw new Error("invalid response framing");
    const parsed = parseJsonRejectingDuplicateKeys(lines[0]!);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("invalid response");
    }
    const record = parsed as Record<string, unknown>;
    const keys = Object.keys(record).sort().join("\u0000");
    if (record["status"] === "ok" && keys === "detail\u0000status" && oneLine(record["detail"])) {
      return { configured: true };
    }
    if (
      record["status"] === "error" &&
      keys === "detail\u0000fix\u0000status" &&
      oneLine(record["detail"]) &&
      oneLine(record["fix"])
    ) {
      return { configured: false, detail: record["detail"], fix: record["fix"] };
    }
    throw new Error("invalid response shape");
  } catch {
    return {
      configured: false,
      detail: "Warden credential-helper authority probe unavailable",
      fix: "reinstall keel and run: keel doctor",
    };
  }
}

function insideWorkspace(workspaceRoot: string, candidate: string): boolean {
  const offset = relative(workspaceRoot, candidate);
  return offset === "" || (!offset.startsWith("..") && !isAbsolute(offset));
}

function versionProbe(executable: string): string | undefined {
  try {
    const executableDir = dirname(executable);
    const raw = execFileSync(executable, ["--version"], {
      cwd: executableDir,
      env: {
        PATH: [executableDir, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
        LANG: "C",
        LC_ALL: "C",
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
      maxBuffer: 1_024,
    }).trim();
    return supportedGitPushVersion(raw) === undefined ? undefined : raw;
  } catch {
    return undefined;
  }
}

function resolveDoctorGitExecutable(
  options: GatherDoctorGitProbeOptions,
): { readonly path: string; readonly versionRaw: string } | undefined {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "linux") return undefined;
  let workspaceRoot: string;
  try {
    workspaceRoot = realpathSync(options.workspaceRoot);
  } catch {
    return undefined;
  }
  for (const entry of (options.env ?? process.env)["PATH"]?.split(delimiter) ?? []) {
    if (entry === "" || !isAbsolute(entry)) continue;
    try {
      const candidate = realpathSync(join(entry, "git"));
      const stat = lstatSync(candidate);
      accessSync(candidate, constants.X_OK);
      if (!stat.isFile() || stat.isSymbolicLink() || insideWorkspace(workspaceRoot, candidate)) {
        continue;
      }
      const versionRaw = versionProbe(candidate);
      if (versionRaw !== undefined) return { path: candidate, versionRaw };
    } catch {
      // A PATH entry that cannot produce one exact supported file supplies no doctor authority.
    }
  }
  return undefined;
}

function exactLineProbe(
  executable: string,
  args: readonly string[],
  workspaceRoot: string,
  env: NodeJS.ProcessEnv,
): string | null {
  try {
    const raw = execFileSync(executable, [...args], {
      cwd: workspaceRoot,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
      maxBuffer: 4 * 1_024,
    });
    return raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  } catch {
    return null;
  }
}

/** Gather only non-secret Git readiness facts through one exact executable outside the workspace. */
export function gatherDoctorGitProbe(options: GatherDoctorGitProbeOptions): DoctorGitProbe {
  const resolved = resolveDoctorGitExecutable(options);
  if (resolved === undefined) {
    return {
      gitVersionRaw: null,
      gitRemoteUrlRaw: null,
      gitCredentialHelperConfigured: false,
    };
  }
  const workspaceRoot = realpathSync(options.workspaceRoot);
  const env = options.env ?? process.env;
  const gitRemoteUrlRaw = exactLineProbe(
    resolved.path,
    ["config", "--local", "--no-includes", "--get-all", "remote.origin.url"],
    workspaceRoot,
    env,
  );
  if (gitRemoteUrlRaw !== null && gitRemoteUrlRaw !== "") {
    const authority =
      options.wardenStart === undefined
        ? {
            configured: false,
            detail: "Warden credential-helper authority probe unavailable",
            fix: "reinstall keel and run: keel doctor",
          }
        : credentialAuthorityProbe(options.wardenStart, workspaceRoot, gitRemoteUrlRaw, env);
    return {
      gitVersionRaw: resolved.versionRaw,
      gitRemoteUrlRaw,
      gitCredentialHelperConfigured: authority.configured,
      ...(authority.detail === undefined || authority.fix === undefined
        ? {}
        : {
            gitCredentialHelperAuthorityIssue: {
              detail: authority.detail,
              fix: authority.fix,
            },
          }),
    };
  }
  return {
    gitVersionRaw: resolved.versionRaw,
    gitRemoteUrlRaw,
    gitCredentialHelperConfigured: false,
  };
}
