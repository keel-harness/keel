import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProjectReader } from "./project-reader.js";

/** True iff real path `p` is `realRoot` or a descendant (relative-based, never `startsWith`). */
function within(realRoot: string, p: string): boolean {
  const rel = relative(realRoot, p);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep));
}

/**
 * SKILL.md handling (§7 Epic 1.7) — agentskills.io-compatible, **declarative only** (ADR-0026): a skill
 * is metadata + a markdown body, never executable code. Discovery emits compact **stubs** (name +
 * description, ~30–80 tokens); the body is loaded **only on trigger** (the `skill` tool). Curated small
 * skill sets beat sprawling ones, so built-in skills are capped (~12) and the discovery list warns past
 * ~20.
 */

/** A discovered skill's stub — everything the model needs to DECIDE to use it, never the body. */
export interface SkillStub {
  readonly name: string;
  readonly description: string;
  readonly source: "builtin" | "project" | "user";
  /** Absolute dir containing this skill's `SKILL.md` (for the lazy body load). */
  readonly dir: string;
}

/** Built-in skills shipped with keel are capped here — published evidence shows curated ≤12 skill sets
 *  dramatically outperform sprawling ones. User/project skills are uncapped (the list warns past ~20). */
export const BUILTIN_SKILL_CAP = 12;

/** The discovery list warns past this many total skills (sprawl dilutes selection). */
const WARN_THRESHOLD = 20;

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;

function stripQuotes(v: string): string {
  if (
    v.length >= 2 &&
    ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
  ) {
    return v.slice(1, -1);
  }
  return v;
}

/**
 * Parse a SKILL.md's YAML frontmatter for `name` + `description` (the only fields keel needs). A
 * minimal line-based parser (no YAML dependency for two simple fields): `key: value`, splitting on the
 * first colon so colons survive in values, with surrounding quotes stripped. Returns `undefined` when
 * the frontmatter is missing or either field is absent/empty.
 */
export function parseSkillFrontmatter(
  content: string,
): { name: string; description: string } | undefined {
  const m = FRONTMATTER.exec(content);
  if (m === null) return undefined;
  const fields: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    fields[line.slice(0, idx).trim()] = stripQuotes(line.slice(idx + 1).trim());
  }
  const name = fields["name"];
  const description = fields["description"];
  if (name === undefined || name === "" || description === undefined || description === "") {
    return undefined;
  }
  return { name, description };
}

/** The SKILL.md body (everything after the frontmatter), or the whole content if there is none. */
export function skillBody(content: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/.exec(content);
  return (m?.[1] ?? content).trim();
}

/**
 * Discover skills directly under one source dir (`<dir>/<skill>/SKILL.md`), using injected `list`/`read`
 * so the caller decides whether the reads are gated (project skills → the trust-gated `ProjectReader`)
 * or direct (built-in/user skills → keel/user-owned, not workspace content). The body is **never**
 * loaded here — the stub carries only name + description.
 */
export function discoverSkillsIn(
  dir: string,
  source: SkillStub["source"],
  list: (p: string) => string[],
  read: (p: string) => string | undefined,
): { stubs: SkillStub[]; malformed: string[] } {
  const stubs: SkillStub[] = [];
  const malformed: string[] = [];
  for (const entry of list(dir)) {
    const name = entry.replace(/\/+$/, "");
    const content = read(join(dir, name, "SKILL.md"));
    if (content === undefined) continue; // no SKILL.md → not a skill dir (not an error)
    const fm = parseSkillFrontmatter(content);
    if (fm !== undefined) {
      stubs.push({ name: fm.name, description: fm.description, source, dir: join(dir, name) });
    } else {
      malformed.push(name); // a SKILL.md exists but lacks name/description — report, don't drop silently
    }
  }
  return { stubs, malformed };
}

/** Apply the built-in budget: keep the first ~12 (sorted by name for determinism), report the rest
 *  dropped (never silently). User/project skills are not passed here (they are uncapped). */
export function capBuiltins(stubs: readonly SkillStub[]): {
  stubs: SkillStub[];
  dropped: number;
} {
  if (stubs.length <= BUILTIN_SKILL_CAP) return { stubs: [...stubs], dropped: 0 };
  const sorted = [...stubs].sort((a, b) => a.name.localeCompare(b.name));
  return { stubs: sorted.slice(0, BUILTIN_SKILL_CAP), dropped: stubs.length - BUILTIN_SKILL_CAP };
}

/**
 * Render the discovery list as one compact system message — one ~30–80-token stub per skill (name +
 * description, never the body), naming the `skill` tool as the trigger. Warns past ~20 skills and notes
 * any dropped built-ins honestly. Returns `undefined` when there are no skills.
 */
export function renderSkillStubs(
  stubs: readonly SkillStub[],
  builtinDropped = 0,
  malformed: readonly string[] = [],
): string | undefined {
  if (stubs.length === 0 && builtinDropped === 0 && malformed.length === 0) return undefined;
  const lines = [
    "# Skills — load a skill's full instructions on demand with the `skill` tool (by name).",
  ];
  // Surface provenance (CTX-2 / ADR-0064): a non-built-in skill is workspace/user-supplied, so tag it
  // with its `source` (`[project]` / `[user]`). A built-in is keel-curated and untagged. This makes a
  // SHADOW visible — a project skill that reuses a built-in's name (e.g. `commit`) shows `commit
  // [project]` rather than silently posing as the trusted built-in. Honest framing (pairs with the
  // CTX-1 body fence); not a containment claim.
  for (const s of stubs) {
    const tag = s.source === "builtin" ? "" : ` [${s.source}]`;
    lines.push(`- ${s.name}${tag} — ${s.description}`);
  }
  if (stubs.length > WARN_THRESHOLD) {
    lines.push(
      `(${String(stubs.length)} skills available — a large set dilutes selection; consider trimming.)`,
    );
  }
  if (builtinDropped > 0) {
    lines.push(
      `(${String(builtinDropped)} built-in skill(s) over the ~${String(BUILTIN_SKILL_CAP)} cap not shown.)`,
    );
  }
  if (malformed.length > 0) {
    lines.push(
      `(skipped ${String(malformed.length)} malformed skill manifest(s): ${malformed.join(", ")} — ` +
        `each needs a SKILL.md with 'name' and 'description' frontmatter.)`,
    );
  }
  return lines.join("\n");
}

/** The source dirs skills are discovered under: keel's shipped built-ins, the user-scope dir, and the
 *  workspace's project dir. All discovery routes through the trust-gated reader (see `buildSkillRegistry`). */
export interface SkillSources {
  readonly builtinDir?: string;
  readonly userDir?: string;
  readonly projectDir?: string;
  /** Workspace root the PROJECT skills must stay within (realpath-contained, so a symlinked skill dir/
   *  SKILL.md whose real target escapes the root is not read — HON-2). Built-in/user dirs are keel/
   *  user-owned and legitimately outside the workspace, so they are NOT contained against this. */
  readonly projectRoot?: string;
}

/**
 * The discovered skill set + the lazy body loader (the trigger). `stubText` is the compact discovery
 * list seeded as context; `loadBody(name)` reads a skill's full body **on demand** (the `skill` tool).
 */
export interface SkillRegistry {
  readonly stubs: readonly SkillStub[];
  readonly stubText?: string;
  loadBody(name: string): string | undefined;
}

/**
 * keel's shipped built-in skills dir (`<repo>/skills`), resolved from this module's location. Phase-1
 * source mode resolves to the repo dir; the bun-compiled binary will bundle/override this (Epic 1.10
 * packaging follow-up). Tests inject `SkillSources.builtinDir` instead of relying on this.
 */
export function defaultBuiltinSkillsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "skills");
}

/**
 * Build the skill registry by discovering all sources **through the trust-gated `ProjectReader`** — so
 * an untrusted workspace discovers nothing and performs zero reads (trust-before-parse). Built-in skills
 * are capped (~12). The body is never loaded here (only name+description stubs); `loadBody` reads it on
 * trigger, again through the gated reader. Phase-1 choice: built-in skills are gated like project skills
 * (a declined workspace gets no skills) — keeps the single chokepoint clean and SEC-012 provable; a
 * refinement could surface keel-owned built-ins regardless of trust.
 */
/** Source precedence when two skills share a name: project overrides user overrides built-in. */
const SOURCE_RANK: Record<SkillStub["source"], number> = { builtin: 0, user: 1, project: 2 };

export function buildSkillRegistry(reader: ProjectReader, sources: SkillSources): SkillRegistry {
  const list = (p: string): string[] => reader.listDir(p);
  const read = (p: string): string | undefined => reader.readFile(p);
  // PROJECT skills are workspace-local: a read whose realpath escapes the workspace root is refused
  // (a symlinked skill dir / SKILL.md pointing outside — HON-2). Built-in/user dirs are not contained.
  const realProjectRoot =
    sources.projectRoot !== undefined ? reader.realpath(sources.projectRoot) : undefined;
  const contained = (p: string): boolean => {
    if (realProjectRoot === undefined) return true; // no root configured → no extra containment
    const real = reader.realpath(p);
    return real !== undefined && within(realProjectRoot, real);
  };
  const projList = (p: string): string[] => (contained(p) ? list(p) : []);
  const projRead = (p: string): string | undefined => (contained(p) ? read(p) : undefined);
  const empty = { stubs: [] as SkillStub[], malformed: [] as string[] };
  const builtinRaw = sources.builtinDir
    ? discoverSkillsIn(sources.builtinDir, "builtin", list, read)
    : empty;
  const { stubs: builtin, dropped } = capBuiltins(builtinRaw.stubs);
  const user = sources.userDir ? discoverSkillsIn(sources.userDir, "user", list, read) : empty;
  const project = sources.projectDir
    ? discoverSkillsIn(sources.projectDir, "project", projList, projRead)
    : empty;
  const malformed = [...builtinRaw.malformed, ...user.malformed, ...project.malformed];
  // Dedup by name with precedence (project > user > builtin) so a project skill can override a
  // built-in, then name-sort for a deterministic, cache-stable stub list (never filesystem order).
  const byName = new Map<string, SkillStub>();
  for (const s of [...builtin, ...user.stubs, ...project.stubs]) {
    const existing = byName.get(s.name);
    if (existing === undefined || SOURCE_RANK[s.source] >= SOURCE_RANK[existing.source]) {
      byName.set(s.name, s);
    }
  }
  const stubs = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  const stubText = renderSkillStubs(stubs, dropped, malformed);
  return {
    stubs,
    ...(stubText !== undefined ? { stubText } : {}),
    loadBody(name: string): string | undefined {
      const stub = byName.get(name);
      if (stub === undefined) return undefined;
      // A project skill's body read is workspace-contained too (a symlinked SKILL.md cannot escape).
      const content =
        stub.source === "project"
          ? projRead(join(stub.dir, "SKILL.md"))
          : read(join(stub.dir, "SKILL.md"));
      return content === undefined ? undefined : skillBody(content);
    },
  };
}
