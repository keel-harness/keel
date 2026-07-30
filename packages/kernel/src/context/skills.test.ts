import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { estimateTokens } from "./system-prompt.js";
import { type ProjectFs, ProjectReader, defaultProjectFs } from "./project-reader.js";
import {
  BUILTIN_SKILL_CAP,
  type SkillStub,
  buildSkillRegistry,
  capBuiltins,
  discoverSkillsIn,
  parseSkillFrontmatter,
  renderSkillStubs,
  skillBody,
} from "./skills.js";

const FM = (name: string, desc: string, body = "the body"): string =>
  `---\nname: ${name}\ndescription: ${desc}\n---\n${body}`;

describe("parseSkillFrontmatter — agentskills.io-compatible YAML frontmatter (name + description)", () => {
  it("parses name + description from a well-formed SKILL.md", () => {
    expect(parseSkillFrontmatter(FM("commit", "Use when writing a git commit"))).toEqual({
      name: "commit",
      description: "Use when writing a git commit",
    });
  });

  it("keeps colons inside the description value", () => {
    expect(parseSkillFrontmatter(FM("x", "Use when: you debug a test"))?.description).toBe(
      "Use when: you debug a test",
    );
  });

  it("strips surrounding quotes from values", () => {
    expect(parseSkillFrontmatter("---\nname: \"q\"\ndescription: 'd'\n---\nb")).toEqual({
      name: "q",
      description: "d",
    });
  });

  it("returns undefined when frontmatter is missing or a field is absent/empty", () => {
    expect(parseSkillFrontmatter("no frontmatter here")).toBeUndefined();
    expect(parseSkillFrontmatter("---\nname: x\n---\nbody")).toBeUndefined(); // no description
    expect(parseSkillFrontmatter("---\ndescription: d\n---\nbody")).toBeUndefined(); // no name
    expect(parseSkillFrontmatter("---\nname:\ndescription: d\n---\nbody")).toBeUndefined(); // empty name
  });
});

describe("skillBody — the SKILL.md body after the frontmatter (lazy-loaded on trigger)", () => {
  it("returns the markdown body only", () => {
    expect(skillBody(FM("x", "d", "Step 1: do the thing"))).toBe("Step 1: do the thing");
  });
  it("returns the whole content when there is no frontmatter", () => {
    expect(skillBody("just a body")).toBe("just a body");
  });
});

describe("discoverSkillsIn — discover skills under one source dir (injected list/read)", () => {
  const dirs: Record<string, string[]> = { "/sk": ["commit/", "review/", "notskill/"] };
  const files: Record<string, string> = {
    "/sk/commit/SKILL.md": FM("commit", "Use when committing", "x".repeat(5000)),
    "/sk/review/SKILL.md": FM("review", "Use when reviewing"),
    // notskill/ has no SKILL.md
  };
  const list = (p: string): string[] => dirs[p] ?? [];
  const read = (p: string): string | undefined => files[p];

  it("finds each subdir with a valid SKILL.md, skipping the rest", () => {
    const { stubs } = discoverSkillsIn("/sk", "builtin", list, read);
    expect(stubs.map((s) => s.name).sort()).toEqual(["commit", "review"]);
    expect(stubs.every((s) => s.source === "builtin")).toBe(true);
    expect(stubs.find((s) => s.name === "commit")?.dir).toBe("/sk/commit");
  });

  it("the stub carries ONLY name + description — never the (5KB) body", () => {
    const commit = discoverSkillsIn("/sk", "builtin", list, read).stubs.find(
      (s) => s.name === "commit",
    )!;
    expect(commit.description).toBe("Use when committing");
    expect(JSON.stringify(commit)).not.toMatch(/x{100}/); // the huge body is absent
  });

  it("a SKILL.md that exists but fails to parse is reported MALFORMED, not silently skipped", () => {
    const d: Record<string, string[]> = { "/sk": ["ok/", "broken/", "nofm/"] };
    const fl: Record<string, string> = {
      "/sk/ok/SKILL.md": FM("ok", "valid"),
      "/sk/broken/SKILL.md": "no frontmatter at all", // present but unparseable → malformed
      // nofm/ has no SKILL.md → just absent, NOT malformed
    };
    const r = discoverSkillsIn(
      "/sk",
      "project",
      (p) => d[p] ?? [],
      (p) => fl[p],
    );
    expect(r.stubs.map((s) => s.name)).toEqual(["ok"]);
    expect(r.malformed).toEqual(["broken"]); // named, not dropped silently
  });
});

describe("capBuiltins — the ~12 built-in skill budget (curated > sprawling)", () => {
  const make = (n: number): SkillStub[] =>
    Array.from({ length: n }, (_, i) => ({
      name: `s${String(i).padStart(2, "0")}`,
      description: "d",
      source: "builtin" as const,
      dir: `/b/s${String(i)}`,
    }));

  it("keeps all when within the cap", () => {
    const { stubs, dropped } = capBuiltins(make(BUILTIN_SKILL_CAP));
    expect(stubs).toHaveLength(BUILTIN_SKILL_CAP);
    expect(dropped).toBe(0);
  });

  it("caps to ~12 and reports the dropped count (never silent)", () => {
    const { stubs, dropped } = capBuiltins(make(BUILTIN_SKILL_CAP + 3));
    expect(stubs).toHaveLength(BUILTIN_SKILL_CAP);
    expect(dropped).toBe(3);
  });
});

describe("renderSkillStubs — the compact discovery list seeded as context", () => {
  const stub = (name: string, description: string): SkillStub => ({
    name,
    description,
    source: "builtin",
    dir: `/b/${name}`,
  });

  it("renders each skill as a small stub naming the `skill` tool as the trigger", () => {
    const text = renderSkillStubs([stub("commit", "Use when writing a git commit message")])!;
    expect(text).toMatch(/commit/);
    expect(text).toMatch(/Use when writing a git commit message/);
    expect(text).toMatch(/skill/i); // names the trigger tool
  });

  it("keeps each stub within the ~30-80 token budget (stubs, not bodies)", () => {
    const text = renderSkillStubs([stub("commit", "Use when writing a git commit message")])!;
    // one stub + a short header — comfortably under a small budget; bodies are never here
    expect(estimateTokens(text)).toBeLessThan(120);
  });

  it("annotates a non-built-in skill with its source so a workspace skill (and any built-in shadow) is visible (CTX-2)", () => {
    const projectCommit: SkillStub = {
      name: "commit",
      description: "shadowed commit",
      source: "project",
      dir: "/ws/commit",
    };
    const text = renderSkillStubs([projectCommit, stub("review", "built-in review")])!;
    expect(text).toMatch(/commit \[project\]/); // the workspace skill is tagged with its source…
    expect(text).toMatch(/- review — built-in review/); // …the keel-curated built-in is NOT tagged
    expect(text).not.toMatch(/review \[/);
  });

  it("warns when the discovery list grows past ~20 skills (sprawl dilutes selection)", () => {
    const many = Array.from({ length: 21 }, (_, i) => stub(`s${String(i)}`, "d"));
    expect(renderSkillStubs(many)).toMatch(/21 skills/);
  });

  it("notes dropped built-ins honestly", () => {
    expect(renderSkillStubs([stub("a", "d")], 2)).toMatch(/2 .*built-in.*not shown|dropped/i);
  });

  it("returns undefined when there are no skills", () => {
    expect(renderSkillStubs([])).toBeUndefined();
  });
});

describe("buildSkillRegistry — discover through the trust gate; body loads only on trigger", () => {
  const FM = (n: string, d: string, body: string): string =>
    `---\nname: ${n}\ndescription: ${d}\n---\n${body}`;
  const dirs: Record<string, string[]> = {
    "/builtin": ["commit/"],
    "/ws/.keel/skills": ["deploy/"],
  };
  const files: Record<string, string> = {
    "/builtin/commit/SKILL.md": FM("commit", "Use when committing", "COMMIT-BODY-STEPS"),
    "/ws/.keel/skills/deploy/SKILL.md": FM("deploy", "Use when deploying", "DEPLOY-BODY-STEPS"),
  };
  const sources = { builtinDir: "/builtin", projectDir: "/ws/.keel/skills" };
  const spyFs = (): ProjectFs & { reads: number } => {
    const fs = {
      reads: 0,
      listDir: (p: string): string[] => {
        fs.reads++;
        return dirs[p] ?? [];
      },
      readFile: (p: string): string | undefined => {
        fs.reads++;
        return files[p];
      },
      probeVersion: (): string | undefined => undefined,
      realpath: (p: string): string | undefined => {
        fs.reads++;
        return p;
      },
    };
    return fs;
  };

  it("trusted: discovers built-in + project skills; the stub list excludes bodies", () => {
    const reg = buildSkillRegistry(new ProjectReader(spyFs(), { trusted: true }), sources);
    expect(reg.stubs.map((s) => s.name).sort()).toEqual(["commit", "deploy"]);
    expect(reg.stubText).toMatch(/commit/);
    expect(reg.stubText).toMatch(/deploy/);
    expect(reg.stubText).not.toMatch(/BODY-STEPS/); // bodies are NOT in the discovery context
  });

  it("the body loads only on trigger (loadBody), not at discovery", () => {
    const reg = buildSkillRegistry(new ProjectReader(spyFs(), { trusted: true }), sources);
    expect(reg.loadBody("commit")).toBe("COMMIT-BODY-STEPS");
    expect(reg.loadBody("deploy")).toBe("DEPLOY-BODY-STEPS");
    expect(reg.loadBody("nonesuch")).toBeUndefined();
  });

  it("untrusted: discovers nothing and performs zero real reads (trust-before-parse)", () => {
    const fs = spyFs();
    const reg = buildSkillRegistry(new ProjectReader(fs, { trusted: false }), sources);
    expect(reg.stubs).toEqual([]);
    expect(reg.stubText).toBeUndefined();
    expect(reg.loadBody("commit")).toBeUndefined();
    expect(fs.reads).toBe(0);
  });

  it("surfaces a malformed manifest in the discovery context (a useful error, not a silent drop)", () => {
    const d: Record<string, string[]> = { "/b": ["good/", "bad/"] };
    const f: Record<string, string> = {
      "/b/good/SKILL.md": FM("good", "valid", "BODY"),
      "/b/bad/SKILL.md": "missing frontmatter",
    };
    const pf: ProjectFs = {
      listDir: (p) => d[p] ?? [],
      readFile: (p) => f[p],
      probeVersion: () => undefined,
      realpath: (p) => p,
    };
    const reg = buildSkillRegistry(new ProjectReader(pf, { trusted: true }), { builtinDir: "/b" });
    expect(reg.stubs.map((s) => s.name)).toEqual(["good"]);
    expect(reg.stubText).toMatch(/malformed skill manifest/i);
    expect(reg.stubText).toMatch(/bad/); // names the offending dir
  });

  it("dedups by name with precedence project > user > builtin, and name-sorts the output", () => {
    const d: Record<string, string[]> = {
      "/b": ["shared/", "zeta/"],
      "/p": ["shared/", "alpha/"],
    };
    const f: Record<string, string> = {
      "/b/shared/SKILL.md": FM("shared", "builtin shared", "BUILTIN-SHARED"),
      "/b/zeta/SKILL.md": FM("zeta", "builtin zeta", "ZETA"),
      "/p/shared/SKILL.md": FM("shared", "project shared", "PROJECT-SHARED"),
      "/p/alpha/SKILL.md": FM("alpha", "project alpha", "ALPHA"),
    };
    const pf: ProjectFs = {
      listDir: (p) => d[p] ?? [],
      readFile: (p) => f[p],
      probeVersion: () => undefined,
      realpath: (p) => p,
    };
    const reg = buildSkillRegistry(new ProjectReader(pf, { trusted: true }), {
      builtinDir: "/b",
      projectDir: "/p",
    });
    // one 'shared' stub, project wins; loadBody returns the PROJECT body
    expect(reg.stubs.filter((s) => s.name === "shared")).toHaveLength(1);
    expect(reg.stubs.find((s) => s.name === "shared")?.source).toBe("project");
    expect(reg.loadBody("shared")).toBe("PROJECT-SHARED");
    // deterministic name-sorted output (alpha · shared · zeta), not filesystem order
    expect(reg.stubs.map((s) => s.name)).toEqual(["alpha", "shared", "zeta"]);
  });

  it("frontmatter name controls shadowing, even when the project dir name differs", () => {
    const d: Record<string, string[]> = {
      "/b": ["commit/"],
      "/p": ["innocent-dir/"],
    };
    const f: Record<string, string> = {
      "/b/commit/SKILL.md": FM("commit", "builtin commit", "BUILTIN-COMMIT"),
      "/p/innocent-dir/SKILL.md": FM("commit", "project-shadowed commit", "PROJECT-COMMIT"),
    };
    const pf: ProjectFs = {
      listDir: (p) => d[p] ?? [],
      readFile: (p) => f[p],
      probeVersion: () => undefined,
      realpath: (p) => p,
    };

    const reg = buildSkillRegistry(new ProjectReader(pf, { trusted: true }), {
      builtinDir: "/b",
      projectDir: "/p",
    });

    expect(reg.stubs).toEqual([
      {
        name: "commit",
        description: "project-shadowed commit",
        source: "project",
        dir: "/p/innocent-dir",
      },
    ]);
    expect(reg.loadBody("commit")).toBe("PROJECT-COMMIT");
  });

  it("does NOT discover/load a project skill symlinked outside the workspace root (HON-2)", () => {
    const root = mkdtempSync(join(tmpdir(), "keel-skroot-"));
    const outside = mkdtempSync(join(tmpdir(), "keel-skout-"));
    mkdirSync(join(outside, "evil"));
    writeFileSync(
      join(outside, "evil", "SKILL.md"),
      FM("evil", "exfiltrate", "OUTSIDE-SKILL-BODY"),
    );
    const projectDir = join(root, ".keel", "skills");
    mkdirSync(projectDir, { recursive: true });
    symlinkSync(join(outside, "evil"), join(projectDir, "evil")); // skill dir symlinked outside
    const reg = buildSkillRegistry(new ProjectReader(defaultProjectFs(), { trusted: true }), {
      projectDir,
      projectRoot: root,
    });
    expect(reg.stubs.find((s) => s.name === "evil")).toBeUndefined(); // escaping skill not discovered
    expect(reg.loadBody("evil")).toBeUndefined(); // and its body cannot be loaded
  });
});
