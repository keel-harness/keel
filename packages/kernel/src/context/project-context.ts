import { cpus, totalmem } from "node:os";
import { join } from "node:path";
import { type SnapshotDeps, environmentSnapshot } from "./environment.js";
import { loadAgentsInstructions } from "./agents-md.js";
import {
  type SkillRegistry,
  type SkillSources,
  buildSkillRegistry,
  defaultBuiltinSkillsDir,
} from "./skills.js";
import { type ProjectFs, ProjectReader, defaultProjectFs } from "./project-reader.js";
import { keelHome } from "../session/paths.js";
import {
  type ResolveTrustDeps,
  type TrustDecision,
  type TrustPromptInfo,
  resolveWorkspaceTrust,
} from "../trust/resolve.js";
import { loadTrustDecision, saveTrustDecision } from "../trust/trust-store.js";

/** System resources reported in the environment snapshot — not project-local, so never trust-gated. */
export interface SystemInfo {
  readonly cores: number;
  readonly memGB: number;
}

/** Real system info from `os`. */
export function systemInfo(): SystemInfo {
  return { cores: cpus().length, memGB: Math.round(totalmem() / 1024 ** 3) };
}

/** The project-local context loaded post-trust. */
export interface ProjectContext {
  /** Whether the workspace was trusted this run — the snapshot/project-read gate (SEC-012). */
  readonly trusted: boolean;
  /** The environment snapshot (cwd / toolchains / files / system). */
  readonly environment?: string;
  /** The merged hierarchical AGENTS.md project instructions, if any. */
  readonly instructions?: string;
  /** The compact SKILL.md discovery list (stubs) seeded as context, if any skills were found. */
  readonly skills?: string;
  /** The skill registry (lazy body loader) — wired into the `skill` tool when skills exist. */
  readonly skillRegistry?: SkillRegistry;
}

/**
 * Load the project context **through the trust gate**. When the reader is untrusted, returns an empty
 * context (the agent stays functional with no project context — §7 Epic 1.7); when trusted, assembles
 * the environment snapshot + the hierarchical AGENTS.md instructions, sourcing every fs read from the
 * gated `ProjectReader` so the chokepoint stays the single project-read surface. The pure
 * `environmentSnapshot` (Epic 1.6b) is unchanged — it receives `SnapshotDeps` backed by the reader.
 * In Phase 1 the workspace root == cwd, so AGENTS.md discovery roots at `cwd`.
 */
export function loadProjectContext(
  reader: ProjectReader,
  cwd: string,
  sys: SystemInfo,
): ProjectContext {
  if (!reader.trusted) return { trusted: false };
  const deps: SnapshotDeps = {
    listDir: (p) => reader.listDir(p),
    probeVersion: (t) => reader.probeVersion(t),
    cores: sys.cores,
    memGB: sys.memGB,
  };
  const instructions = loadAgentsInstructions(reader, cwd, cwd);
  return {
    trusted: true,
    environment: environmentSnapshot(cwd, deps),
    ...(instructions !== undefined ? { instructions } : {}),
  };
}

/** Composition deps for `gatherProjectContext`. `fs`/`sys`/`loadPersisted` are injectable for hermetic
 *  tests; production uses the real fs, system info, and the user-scope trust store. */
export interface GatherContextDeps {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly trustFlag?: boolean;
  readonly fs?: ProjectFs;
  readonly sys?: SystemInfo;
  readonly loadPersisted?: (root: string, env: NodeJS.ProcessEnv) => TrustDecision | undefined;
  /** Interactive terminal? Required before the trust prompt is shown. */
  readonly isTTY?: boolean;
  /** The interactive trust y/n effect (the bin wires the real stdin prompt). */
  readonly promptTrust?: (info: TrustPromptInfo) => Promise<boolean>;
  /** Skill source dirs (built-in / user / project). Injectable for tests; defaults below. */
  readonly skillDirs?: SkillSources;
}

/** Default skill source dirs: keel's shipped built-ins, the user-scope dir, the workspace project dir. */
function defaultSkillDirs(cwd: string, env: NodeJS.ProcessEnv): SkillSources {
  return {
    builtinDir: defaultBuiltinSkillsDir(),
    userDir: join(keelHome(env), "skills"),
    projectDir: join(cwd, ".keel", "skills"),
    projectRoot: cwd, // contain project skills within the workspace root (symlink escape — HON-2)
  };
}

/**
 * The session-startup composition (§3.2(4) trust-before-parse): resolve the workspace-trust decision
 * (consulting the persisted user-scope store), build the gated `ProjectReader`, then load the context
 * through it. This is the single place keel decides trust and reads project metadata at startup —
 * replacing the pre-trust env-snapshot read the bin used to do unconditionally (the Epic-1.6b carry-in
 * gap).
 */
export async function gatherProjectContext(deps: GatherContextDeps): Promise<ProjectContext> {
  const resolveDeps: ResolveTrustDeps = {
    cwd: deps.cwd,
    loadPersisted: deps.loadPersisted ?? loadTrustDecision,
    persist: saveTrustDecision,
    ...(deps.env !== undefined ? { env: deps.env } : {}),
    ...(deps.trustFlag !== undefined ? { trustFlag: deps.trustFlag } : {}),
    ...(deps.isTTY !== undefined ? { isTTY: deps.isTTY } : {}),
    ...(deps.promptTrust !== undefined ? { prompt: deps.promptTrust } : {}),
  };
  const decision = await resolveWorkspaceTrust(resolveDeps);
  const reader = new ProjectReader(deps.fs ?? defaultProjectFs(), {
    trusted: decision === "trusted",
  });
  const base = loadProjectContext(reader, deps.cwd, deps.sys ?? systemInfo());
  const registry = buildSkillRegistry(
    reader,
    deps.skillDirs ?? defaultSkillDirs(deps.cwd, deps.env ?? process.env),
  );
  return {
    ...base,
    ...(registry.stubText !== undefined ? { skills: registry.stubText } : {}),
    ...(registry.stubs.length > 0 ? { skillRegistry: registry } : {}),
  };
}
