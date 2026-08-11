import { spawnSync } from "node:child_process";
import { accessSync, constants, lstatSync, realpathSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, relative } from "node:path";
import { supportedGitPushVersion } from "@keel/shared";

export interface ResolveProductionGitExecutableOptions {
  readonly workspaceRoot: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
}

function isInsideWorkspace(workspaceRoot: string, candidate: string): boolean {
  const offset = relative(workspaceRoot, candidate);
  return offset === "" || (!offset.startsWith("..") && !isAbsolute(offset));
}

function supportedGitVersion(executable: string): string | undefined {
  const executableDir = dirname(executable);
  const result = spawnSync(executable, ["--version"], {
    cwd: executableDir,
    env: {
      PATH: [executableDir, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
      LANG: "C",
      LC_ALL: "C",
    },
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 1_024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.error !== undefined || result.status !== 0 || result.signal !== null) return undefined;
  return supportedGitPushVersion(result.stdout);
}

export interface ResolvedProductionGitExecutable {
  readonly path: string;
  readonly version: string;
}

/**
 * Resolve one operator-selected Git executable without accepting project-relative PATH authority.
 *
 * The canonical executable path, rather than the PATH entry or a symlink, is retained and later
 * identity-bound into every review. Native Windows has no enforcing V1 SRT backend, so it cannot
 * acquire this production capability.
 */
export function resolveProductionGitExecutable(
  options: ResolveProductionGitExecutableOptions,
): ResolvedProductionGitExecutable | undefined {
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
      if (!stat.isFile() || stat.isSymbolicLink() || isInsideWorkspace(workspaceRoot, candidate)) {
        continue;
      }
      const version = supportedGitVersion(candidate);
      if (version === undefined) continue;
      return { path: candidate, version };
    } catch {
      // Missing, non-executable, or unstable PATH candidates supply no authority; keep searching.
    }
  }
  return undefined;
}
