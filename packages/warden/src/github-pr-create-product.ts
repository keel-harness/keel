import { spawnSync } from "node:child_process";
import { accessSync, constants, lstatSync, realpathSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, relative } from "node:path";

export interface ResolveProductionCurlExecutableOptions {
  readonly workspaceRoot: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
}

export interface ResolvedProductionCurlExecutable {
  readonly path: string;
  readonly version: string;
}

function isInsideWorkspace(workspaceRoot: string, candidate: string): boolean {
  const offset = relative(workspaceRoot, candidate);
  return offset === "" || (!offset.startsWith("..") && !isAbsolute(offset));
}

function supportedCurlVersion(executable: string): string | undefined {
  const executableDir = dirname(executable);
  const result = spawnSync(executable, ["--disable", "--version"], {
    cwd: executableDir,
    env: {
      PATH: [executableDir, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
      LANG: "C",
      LC_ALL: "C",
    },
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 8 * 1_024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.error !== undefined || result.status !== 0 || result.signal !== null) return undefined;
  const match = /^curl (\d+)\.(\d+)\.(\d+)(?:[ \n]|$)/u.exec(result.stdout);
  if (match === null) return undefined;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if ((major === 7 && minor >= 61) || major === 8) return `${match[1]}.${match[2]}.${match[3]}`;
  return undefined;
}

/** Resolve one tested, operator-selected curl binary without project PATH authority. */
export function resolveProductionCurlExecutable(
  options: ResolveProductionCurlExecutableOptions,
): ResolvedProductionCurlExecutable | undefined {
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
      const candidate = realpathSync(join(entry, "curl"));
      const stat = lstatSync(candidate);
      accessSync(candidate, constants.X_OK);
      if (!stat.isFile() || stat.isSymbolicLink() || isInsideWorkspace(workspaceRoot, candidate)) {
        continue;
      }
      const version = supportedCurlVersion(candidate);
      if (version !== undefined) return { path: candidate, version };
    } catch {
      // Missing, non-executable, or unstable candidates supply no authority.
    }
  }
  return undefined;
}
