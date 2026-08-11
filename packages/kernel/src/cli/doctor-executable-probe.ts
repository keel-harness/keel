import { execFileSync } from "node:child_process";
import { accessSync, constants, lstatSync, realpathSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, relative } from "node:path";

export interface ResolveDoctorExecutableOptions {
  readonly workspaceRoot: string;
  readonly env?: NodeJS.ProcessEnv;
}

export interface ProbeDoctorExecutableOptions {
  readonly env?: NodeJS.ProcessEnv;
}

function insideWorkspace(workspaceRoot: string, candidate: string): boolean {
  const offset = relative(workspaceRoot, candidate);
  return offset === "" || (!offset.startsWith("..") && !isAbsolute(offset));
}

function canonicalExecutableOutsideWorkspace(
  candidate: string,
  workspaceRoot: string,
): string | undefined {
  try {
    const canonical = realpathSync(candidate);
    const stat = lstatSync(canonical);
    accessSync(canonical, constants.X_OK);
    if (!stat.isFile() || insideWorkspace(workspaceRoot, canonical)) return undefined;
    return canonical;
  } catch {
    return undefined;
  }
}

/** Resolve one exact executable without admitting relative or workspace-controlled PATH entries. */
export function resolveDoctorExecutable(
  commandOrPath: string,
  options: ResolveDoctorExecutableOptions,
): string | undefined {
  let workspaceRoot: string;
  try {
    workspaceRoot = realpathSync(options.workspaceRoot);
  } catch {
    return undefined;
  }

  if (isAbsolute(commandOrPath)) {
    return canonicalExecutableOutsideWorkspace(commandOrPath, workspaceRoot);
  }
  if (commandOrPath === "" || basename(commandOrPath) !== commandOrPath) return undefined;

  for (const entry of (options.env ?? process.env)["PATH"]?.split(delimiter) ?? []) {
    if (entry === "" || !isAbsolute(entry)) continue;
    const executable = canonicalExecutableOutsideWorkspace(
      join(entry, commandOrPath),
      workspaceRoot,
    );
    if (executable !== undefined) return executable;
  }
  return undefined;
}

/** Probe an already-resolved executable with a bounded, non-project working directory and PATH. */
export function probeDoctorExecutable(
  executable: string,
  args: readonly string[],
  _options: ProbeDoctorExecutableOptions = {},
): string | null {
  if (!isAbsolute(executable)) return null;
  try {
    const canonical = realpathSync(executable);
    if (canonical !== executable) return null;
    const executableDir = dirname(canonical);
    return execFileSync(canonical, [...args], {
      cwd: executableDir,
      env: {
        PATH: [executableDir, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(delimiter),
        LANG: "C",
        LC_ALL: "C",
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
      maxBuffer: 64 * 1_024,
    }).trim();
  } catch {
    return null;
  }
}
