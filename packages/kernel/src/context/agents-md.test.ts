import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectReader, defaultProjectFs } from "./project-reader.js";
import { type ProjectFs } from "./project-reader.js";
import { loadAgentsInstructions } from "./agents-md.js";

const trusted = (): ProjectReader => new ProjectReader(defaultProjectFs(), { trusted: true });
const ws = (): string => mkdtempSync(join(tmpdir(), "keel-agents-"));

describe("loadAgentsInstructions — hierarchical AGENTS.md (root→cwd merge, §7 Epic 1.7)", () => {
  it("returns undefined when there is no AGENTS.md anywhere", () => {
    const root = ws();
    expect(loadAgentsInstructions(trusted(), root, root)).toBeUndefined();
  });

  it("loads a single root AGENTS.md, labeled with its path", () => {
    const root = ws();
    writeFileSync(join(root, "AGENTS.md"), "use pnpm, not npm");
    const out = loadAgentsInstructions(trusted(), root, root)!;
    expect(out).toMatch(/use pnpm, not npm/);
    expect(out).toMatch(/AGENTS\.md/); // path-labeled section header
  });

  it("prefixes the block with a workspace-supplied provenance fence (CTX-1)", () => {
    const root = ws();
    writeFileSync(join(root, "AGENTS.md"), "use pnpm, not npm");
    const out = loadAgentsInstructions(trusted(), root, root)!;
    expect(out).toContain("use pnpm, not npm"); // the content is still delivered…
    expect(out).toContain("provenance: workspace-supplied"); // …behind a provenance marker
    // The fence precedes the content (it frames everything below it).
    expect(out.indexOf("provenance: workspace-supplied")).toBeLessThan(out.indexOf("use pnpm"));
  });

  it("merges root→cwd in order (root first, the most specific cwd last)", () => {
    const root = ws();
    const deep = join(root, "pkg", "app");
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(root, "AGENTS.md"), "ROOT-RULE");
    writeFileSync(join(root, "pkg", "AGENTS.md"), "PKG-RULE");
    writeFileSync(join(deep, "AGENTS.md"), "APP-RULE");
    const out = loadAgentsInstructions(trusted(), root, deep)!;
    // all three present, in root→cwd order
    expect(out.indexOf("ROOT-RULE")).toBeGreaterThanOrEqual(0);
    expect(out.indexOf("ROOT-RULE")).toBeLessThan(out.indexOf("PKG-RULE"));
    expect(out.indexOf("PKG-RULE")).toBeLessThan(out.indexOf("APP-RULE"));
  });

  it("NEVER reads above the workspace root (containment — a parent AGENTS.md is ignored)", () => {
    const parent = ws();
    const root = join(parent, "repo");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(parent, "AGENTS.md"), "PARENT-SECRET-RULE"); // above the workspace root
    writeFileSync(join(root, "AGENTS.md"), "REPO-RULE");
    const out = loadAgentsInstructions(trusted(), root, root)!;
    expect(out).toMatch(/REPO-RULE/);
    expect(out).not.toMatch(/PARENT-SECRET-RULE/); // the parent dir is outside trust/containment
  });

  it("does NOT follow a symlinked AGENTS.md file whose real target escapes the root (HON-2)", () => {
    const root = ws();
    const outside = mkdtempSync(join(tmpdir(), "keel-out-"));
    writeFileSync(join(outside, "secret.md"), "OUTSIDE-SECRET-VIA-FILE-SYMLINK");
    symlinkSync(join(outside, "secret.md"), join(root, "AGENTS.md")); // a file symlink, not a dir
    const out = loadAgentsInstructions(trusted(), root, root);
    expect(out).toBeUndefined(); // the escaping file is not read; no other AGENTS.md exists
  });

  it("containment: a symlinked cwd that escapes the root cannot pull in an AGENTS.md from outside", () => {
    // root/sub is a symlink to an OUTSIDE dir; cwd = root/sub is lexically under root but resolves out.
    const outside = ws();
    writeFileSync(join(outside, "AGENTS.md"), "OUTSIDE-VIA-SYMLINK");
    const root = ws();
    writeFileSync(join(root, "AGENTS.md"), "ROOT-RULE");
    symlinkSync(outside, join(root, "sub"));
    const out = loadAgentsInstructions(trusted(), root, join(root, "sub"))!;
    expect(out).toMatch(/ROOT-RULE/);
    expect(out).not.toMatch(/OUTSIDE-VIA-SYMLINK/); // realpath escapes the root → never read
  });

  it("defensive: if cwd is not under root, only the root AGENTS.md is read (never an unrelated tree)", () => {
    const root = ws();
    const unrelated = ws(); // a sibling temp dir, NOT under root
    writeFileSync(join(root, "AGENTS.md"), "ROOT-ONLY");
    writeFileSync(join(unrelated, "AGENTS.md"), "UNRELATED");
    const out = loadAgentsInstructions(trusted(), root, unrelated)!;
    expect(out).toMatch(/ROOT-ONLY/);
    expect(out).not.toMatch(/UNRELATED/);
  });

  it("untrusted reader → undefined and zero real reads (trust-before-parse)", () => {
    const root = ws();
    writeFileSync(join(root, "AGENTS.md"), "rule");
    const fs = defaultProjectFs();
    let reads = 0;
    const counting: ProjectFs = {
      listDir: (p) => {
        reads++;
        return fs.listDir(p);
      },
      readFile: (p) => {
        reads++;
        return fs.readFile(p);
      },
      probeVersion: (t) => fs.probeVersion(t),
      realpath: (p) => {
        reads++;
        return fs.realpath(p);
      },
    };
    const reader = new ProjectReader(counting, { trusted: false });
    expect(loadAgentsInstructions(reader, root, root)).toBeUndefined();
    expect(reads).toBe(0);
  });

  it("caps an oversized AGENTS.md with an honest truncation note (never silently)", () => {
    const root = ws();
    writeFileSync(join(root, "AGENTS.md"), "x".repeat(200_000));
    const out = loadAgentsInstructions(trusted(), root, root)!;
    expect(out.length).toBeLessThan(200_000);
    expect(out).toMatch(/truncated/i);
  });
});
