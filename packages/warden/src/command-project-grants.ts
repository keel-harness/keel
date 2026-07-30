import { readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { type WARDEN_METHODS, keelHome } from "@keel/shared";
import { atomicWriteFile, type AtomicWriteResult } from "./atomic-write.js";
import { withFileLock } from "./file-lock.js";

type Principal = ReturnType<
  (typeof WARDEN_METHODS)["warden.resolveReview"]["params"]["parse"]
>["principal"];

const CommandGrantKey = z.string().regex(/^sha256:[a-f0-9]{64}$/u);

const ProjectCommandGrant = z
  .object({
    key: CommandGrantKey,
    updatedAt: z.string(),
    principal: z.unknown().optional(),
  })
  .strict();

const ProjectCommandGrantEntry = z
  .object({
    grants: z.array(ProjectCommandGrant),
    updatedAt: z.string(),
    principal: z.unknown().optional(),
  })
  .strict();

const ProjectCommandGrantFile = z
  .object({
    version: z.literal(1),
    workspaces: z.record(z.string(), ProjectCommandGrantEntry),
  })
  .strict();

type ProjectCommandGrantT = z.infer<typeof ProjectCommandGrant>;
type ProjectCommandGrantFileT = z.infer<typeof ProjectCommandGrantFile>;

export interface LoadedProjectCommandGrant {
  readonly key: `sha256:${string}`;
  readonly updatedAt: string;
  readonly principal?: unknown;
}

export type ProjectCommandGrantRevokeResult = "revoked" | "not-found" | "write-failed";

export function projectCommandGrantFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(keelHome(env), "command-project-grants.json");
}

function workspaceKey(root: string): string {
  const abs = resolve(root);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

function emptyStore(): ProjectCommandGrantFileT {
  return { version: 1, workspaces: {} };
}

function readStore(env: NodeJS.ProcessEnv): ProjectCommandGrantFileT {
  try {
    const parsed = ProjectCommandGrantFile.safeParse(
      JSON.parse(readFileSync(projectCommandGrantFilePath(env), "utf8")),
    );
    if (parsed.success) return parsed.data;
  } catch {
    /* missing or unreadable store => no persisted command grants */
  }
  return emptyStore();
}

function writeStore(
  store: ProjectCommandGrantFileT,
  env: NodeJS.ProcessEnv,
): AtomicWriteResult | "failed" {
  try {
    return atomicWriteFile(projectCommandGrantFilePath(env), JSON.stringify(store, null, 2), 0o600);
  } catch {
    return "failed";
  }
}

function normalizeGrant(grant: ProjectCommandGrantT): LoadedProjectCommandGrant {
  return {
    key: grant.key as `sha256:${string}`,
    updatedAt: grant.updatedAt,
    ...(grant.principal === undefined ? {} : { principal: grant.principal }),
  };
}

function normalizedGrants(grants: readonly ProjectCommandGrantT[]): LoadedProjectCommandGrant[] {
  const byKey = new Map<string, ProjectCommandGrantT>();
  for (const grant of grants) byKey.set(grant.key, grant);
  return [...byKey.values()].map(normalizeGrant).sort((a, b) => a.key.localeCompare(b.key));
}

export function loadProjectCommandGrants(
  workspaceRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): LoadedProjectCommandGrant[] {
  try {
    const entry = readStore(env).workspaces[workspaceKey(workspaceRoot)];
    if (entry === undefined) return [];
    return normalizedGrants(entry.grants);
  } catch {
    return [];
  }
}

export function saveProjectCommandGrant(
  workspaceRoot: string,
  key: `sha256:${string}`,
  principal: Principal,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  try {
    // Lock the full read-modify-write so a concurrent revoke (kernel process) cannot interleave and
    // resurrect a grant this save read before the revoke landed (fail-open race, pre-launch P0-2).
    return withFileLock(projectCommandGrantFilePath(env), () => {
      const store = readStore(env);
      const now = new Date().toISOString();
      const workspace = workspaceKey(workspaceRoot);
      const existing = store.workspaces[workspace]?.grants ?? [];
      const grants = normalizedGrants([
        ...existing,
        {
          key,
          updatedAt: now,
          principal,
        },
      ]);
      const next: ProjectCommandGrantFileT = {
        version: 1,
        workspaces: {
          ...store.workspaces,
          [workspace]: {
            grants,
            updatedAt: now,
            principal,
          },
        },
      };
      return writeStore(next, env) !== "failed";
    });
  } catch {
    // Fail closed for durable authority (lock busy or IO error): callers must not install a project
    // grant in memory.
    return false;
  }
}

export function revokeProjectCommandGrant(
  workspaceRoot: string,
  key: `sha256:${string}`,
  env: NodeJS.ProcessEnv = process.env,
): ProjectCommandGrantRevokeResult {
  try {
    return withFileLock(projectCommandGrantFilePath(env), () => {
      const store = readStore(env);
      const workspace = workspaceKey(workspaceRoot);
      const entry = store.workspaces[workspace];
      if (entry === undefined) return "not-found" as const;
      const hasTarget = entry.grants.some((grant) => grant.key === key);
      if (!hasTarget) return "not-found" as const;
      const grants = normalizedGrants(entry.grants.filter((grant) => grant.key !== key));
      const nextWorkspaces = { ...store.workspaces };
      if (grants.length === 0) delete nextWorkspaces[workspace];
      else nextWorkspaces[workspace] = { ...entry, grants, updatedAt: new Date().toISOString() };
      return writeStore({ version: 1, workspaces: nextWorkspaces }, env) === "durable"
        ? ("revoked" as const)
        : ("write-failed" as const);
    });
  } catch {
    return "write-failed";
  }
}
