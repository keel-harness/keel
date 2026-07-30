import { readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { keelHome } from "../session/paths.js";
import { atomicWrite } from "../tools/atomic-write.js";
import { withFileLock } from "../tools/file-lock.js";

const PersistedAutopilotMode = z.enum(["autopilot", "project-autopilot"]);
export type PersistedAutopilotModeT = z.infer<typeof PersistedAutopilotMode>;

const AutopilotModeEntry = z
  .object({
    mode: PersistedAutopilotMode,
    updatedAt: z.string(),
    principal: z.string().optional(),
  })
  .strict();

const AutopilotModeFile = z
  .object({
    version: z.literal(1),
    workspaces: z.record(z.string(), AutopilotModeEntry),
  })
  .strict();

type AutopilotModeFileT = z.infer<typeof AutopilotModeFile>;

export interface LoadedProjectAutopilotMode {
  readonly mode: PersistedAutopilotModeT;
  readonly updatedAt: string;
  readonly principal?: string;
}

export type ProjectAutopilotModeSaveResult = "saved" | "write-failed";
export type ProjectAutopilotModeClearResult = "cleared" | "not-found" | "write-failed";

export function projectAutopilotModeFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(keelHome(env), "project-autopilot-modes.json");
}

function workspaceKey(root: string): string {
  const abs = resolve(root);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

function principal(env: NodeJS.ProcessEnv): string {
  return env["USER"] ?? env["LOGNAME"] ?? "unknown";
}

function emptyStore(): AutopilotModeFileT {
  return { version: 1, workspaces: {} };
}

/**
 * Serialize a cross-process read-modify-write of the mode store under `<file>.lock`. Uses the shared
 * `withFileLock` (P1-20): a SIGKILL'd writer's stale lock (dead PID) is RECLAIMED rather than bricking
 * every future mode change forever — the previous hand-rolled `openSync(..,"wx")` had no reclaim, so a
 * dead-PID lock left the store permanently "write-failed" until a manual `rm`. A LIVE holder still
 * fails closed (`FileLockBusyError`), and any `op`/IO error is reported as a failed mutation, so the
 * `boolean` contract callers rely on is unchanged (`withFileLock` creates the parent dir itself).
 */
function withStoreLock(env: NodeJS.ProcessEnv, op: () => boolean): boolean {
  try {
    return withFileLock(projectAutopilotModeFilePath(env), op);
  } catch {
    return false;
  }
}

function readStore(env: NodeJS.ProcessEnv): AutopilotModeFileT {
  try {
    const parsed = AutopilotModeFile.safeParse(
      JSON.parse(readFileSync(projectAutopilotModeFilePath(env), "utf8")),
    );
    if (parsed.success) return parsed.data;
  } catch {
    /* missing or unreadable mode store => default Guided */
  }
  return emptyStore();
}

function writeStore(store: AutopilotModeFileT, env: NodeJS.ProcessEnv): boolean {
  try {
    const path = projectAutopilotModeFilePath(env);
    atomicWrite(path, JSON.stringify(store, null, 2), {}, 0o600);
    return true;
  } catch {
    return false;
  }
}

export function loadProjectAutopilotMode(
  workspaceRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): LoadedProjectAutopilotMode | undefined {
  const entry = readStore(env).workspaces[workspaceKey(workspaceRoot)];
  if (entry === undefined) return undefined;
  return {
    mode: entry.mode,
    updatedAt: entry.updatedAt,
    ...(entry.principal === undefined ? {} : { principal: entry.principal }),
  };
}

export function saveProjectAutopilotMode(
  workspaceRoot: string,
  mode: PersistedAutopilotModeT,
  env: NodeJS.ProcessEnv = process.env,
): ProjectAutopilotModeSaveResult {
  const saved = withStoreLock(env, () => {
    const store = readStore(env);
    const now = new Date().toISOString();
    const next: AutopilotModeFileT = {
      version: 1,
      workspaces: {
        ...store.workspaces,
        [workspaceKey(workspaceRoot)]: {
          mode,
          updatedAt: now,
          principal: principal(env),
        },
      },
    };
    return writeStore(next, env);
  });
  return saved ? "saved" : "write-failed";
}

export function clearProjectAutopilotMode(
  workspaceRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): ProjectAutopilotModeClearResult {
  let result: ProjectAutopilotModeClearResult = "write-failed";
  const ok = withStoreLock(env, () => {
    const store = readStore(env);
    const workspace = workspaceKey(workspaceRoot);
    if (store.workspaces[workspace] === undefined) {
      result = "not-found";
      return true;
    }
    const nextWorkspaces = { ...store.workspaces };
    delete nextWorkspaces[workspace];
    result = writeStore({ version: 1, workspaces: nextWorkspaces }, env)
      ? "cleared"
      : "write-failed";
    return result !== "write-failed";
  });
  return ok ? result : "write-failed";
}
