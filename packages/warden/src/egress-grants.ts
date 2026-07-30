import { readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { type WARDEN_METHODS, keelHome } from "@keel/shared";
import { normalizeEgressGrantDomain } from "./egress-review.js";
import { atomicWriteFile, type AtomicWriteResult } from "./atomic-write.js";
import { withFileLock } from "./file-lock.js";

type Principal = ReturnType<
  (typeof WARDEN_METHODS)["warden.resolveReview"]["params"]["parse"]
>["principal"];

const ProjectEgressGrantEntry = z
  .object({
    domains: z.array(z.string()),
    updatedAt: z.string(),
    principal: z.unknown().optional(),
  })
  .strict();

const ProjectEgressGrantFile = z
  .object({
    version: z.literal(1),
    workspaces: z.record(z.string(), ProjectEgressGrantEntry),
  })
  .strict();

type ProjectEgressGrantFileT = z.infer<typeof ProjectEgressGrantFile>;

export type ProjectEgressGrantRevokeResult = "revoked" | "not-found" | "write-failed";

export function projectEgressGrantFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(keelHome(env), "egress-project-grants.json");
}

function workspaceKey(root: string): string {
  const abs = resolve(root);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

function emptyStore(): ProjectEgressGrantFileT {
  return { version: 1, workspaces: {} };
}

function readStore(env: NodeJS.ProcessEnv): ProjectEgressGrantFileT {
  try {
    const parsed = ProjectEgressGrantFile.safeParse(
      JSON.parse(readFileSync(projectEgressGrantFilePath(env), "utf8")),
    );
    if (parsed.success) return parsed.data;
  } catch {
    /* missing or unreadable store => no persisted grants */
  }
  return emptyStore();
}

function writeStore(
  store: ProjectEgressGrantFileT,
  env: NodeJS.ProcessEnv,
): AtomicWriteResult | "failed" {
  try {
    return atomicWriteFile(projectEgressGrantFilePath(env), JSON.stringify(store, null, 2), 0o600);
  } catch {
    return "failed";
  }
}

function normalizedDomains(domains: readonly string[]): string[] {
  return [...new Set(domains.map((domain) => normalizeEgressGrantDomain(domain)))].sort();
}

export function loadProjectEgressGrants(
  workspaceRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  try {
    const entry = readStore(env).workspaces[workspaceKey(workspaceRoot)];
    if (entry === undefined) return [];
    return normalizedDomains(entry.domains);
  } catch {
    return [];
  }
}

export function saveProjectEgressGrant(
  workspaceRoot: string,
  domain: string,
  principal: Principal,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  try {
    // Lock the full read-modify-write so a concurrent revoke cannot interleave and resurrect a
    // domain this save read before the revoke landed (pre-launch P0-2). On a busy lock the save is
    // skipped and callers install no in-memory grant: durable project authority fails closed.
    return withFileLock(projectEgressGrantFilePath(env), () => {
      const store = readStore(env);
      const key = workspaceKey(workspaceRoot);
      const existing = store.workspaces[key]?.domains ?? [];
      const domains = normalizedDomains([...existing, domain]);
      const next: ProjectEgressGrantFileT = {
        version: 1,
        workspaces: {
          ...store.workspaces,
          [key]: {
            domains,
            updatedAt: new Date().toISOString(),
            principal,
          },
        },
      };
      return writeStore(next, env) !== "failed";
    });
  } catch {
    // Fail closed for durable authority: callers must not install an in-memory project grant.
    return false;
  }
}

export function revokeProjectEgressGrant(
  workspaceRoot: string,
  domain: string,
  env: NodeJS.ProcessEnv = process.env,
): ProjectEgressGrantRevokeResult {
  try {
    const normalized = normalizeEgressGrantDomain(domain);
    return withFileLock(projectEgressGrantFilePath(env), () => {
      const store = readStore(env);
      const workspace = workspaceKey(workspaceRoot);
      const entry = store.workspaces[workspace];
      if (entry === undefined) return "not-found" as const;
      const canonicalDomains = normalizedDomains(entry.domains);
      if (!canonicalDomains.includes(normalized)) return "not-found" as const;
      const domains = canonicalDomains.filter((stored) => stored !== normalized);
      const nextWorkspaces = { ...store.workspaces };
      if (domains.length === 0) delete nextWorkspaces[workspace];
      else nextWorkspaces[workspace] = { ...entry, domains, updatedAt: new Date().toISOString() };
      return writeStore({ version: 1, workspaces: nextWorkspaces }, env) === "durable"
        ? ("revoked" as const)
        : ("write-failed" as const);
    });
  } catch {
    return "write-failed";
  }
}
