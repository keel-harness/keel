import { execFileSync } from "node:child_process";
import { accessSync, constants, lstatSync, realpathSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, relative } from "node:path";
import { supportedGitPushVersion } from "@keel/shared";

export interface GatherDoctorGitProbeOptions {
  readonly workspaceRoot: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
}

export interface DoctorGitProbe {
  readonly gitVersionRaw: string | null;
  readonly gitRemoteUrlRaw: string | null;
  readonly gitCredentialHelperConfigured: boolean;
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

function hasEffectiveCredentialHelper(rawScopes: readonly (string | null)[]): boolean {
  let configured = false;
  for (const raw of rawScopes) {
    if (raw === null) continue;
    for (const line of raw.split("\n")) {
      if (line === "") continue;
      const value = /^credential(?:\..*)?\.helper[\t ]+(.*)$/iu.exec(line)?.[1];
      if (value === undefined) return false;
      configured = value.trim() === "" ? false : true;
    }
  }
  return configured;
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
  const helperArgs = ["--no-includes", "--get-regexp", "^credential(\\..*)?\\.helper$"];
  const systemHelpers = exactLineProbe(
    resolved.path,
    ["config", "--system", ...helperArgs],
    workspaceRoot,
    env,
  );
  const globalHelpers = exactLineProbe(
    resolved.path,
    ["config", "--global", ...helperArgs],
    workspaceRoot,
    env,
  );
  const gitCredentialHelperConfigured = hasEffectiveCredentialHelper([
    systemHelpers,
    globalHelpers,
  ]);
  return {
    gitVersionRaw: resolved.versionRaw,
    gitRemoteUrlRaw,
    gitCredentialHelperConfigured,
  };
}
