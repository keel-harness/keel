import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ProjectFs, ProjectReader } from "./project-reader.js";
import { buildSkillRegistry } from "./skills.js";
import { loadAgentsInstructions } from "./agents-md.js";

/**
 * Epic 1.8 architectural guard (MASTER_SPEC §7 line 889, ADR-0026): **no Phase-1 code path loads or
 * executes workspace / extension code.** Two parts, as the spec requires:
 *   1. grep/AST assertion — the kernel source contains no dynamic-code-execution primitive;
 *   2. runtime instrumentation — a malicious skill/AGENTS.md "executable body" loads as INERT TEXT.
 * Declarative extensibility = data, never code; executable extensions are deferred behind the warden.
 */

const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** All non-test `.ts` files under packages/kernel/src. */
function kernelSources(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...kernelSources(p));
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

describe("Epic 1.8 — declarative-only: no in-process code loading (grep/AST assertion)", () => {
  // Dynamic-code-execution primitives. `child_process` is deliberately NOT here: it is the model's
  // explicit, named tool surface (`bash`/`search`) + the hardcoded `<tool> --version` probe — never a
  // path that auto-loads or runs WORKSPACE/EXTENSION code. This guards against eval/Function/vm/dynamic
  // import/require being introduced (the things that would let project content become executed code).
  const FORBIDDEN: ReadonlyArray<readonly [name: string, re: RegExp]> = [
    ["eval(", /(?<![A-Za-z0-9_.$])eval\s*\(/],
    ["new Function(", /\bnew\s+Function\s*\(/],
    ["vm module", /\bnode:vm\b|\bfrom\s+["']vm["']|\brequire\(\s*["']vm["']\)/],
    ["dynamic import()", /(?<![A-Za-z0-9_.$])import\s*\(\s*[^"'`)]/],
    ["require()", /\brequire\s*\(/],
  ];

  const files = kernelSources(SRC_ROOT);

  it("scans a non-trivial number of kernel source files", () => {
    expect(files.length).toBeGreaterThan(30); // sanity: the walk actually found the tree
  });

  for (const [name, re] of FORBIDDEN) {
    it(`the kernel contains no '${name}' (no dynamic code-loading surface)`, () => {
      const offenders = files.filter((f) => re.test(readFileSync(f, "utf8")));
      expect(offenders.map((f) => f.replace(SRC_ROOT, "kernel/src"))).toEqual([]);
    });
  }
});

describe("Epic 1.8 — declarative-only: project content is INERT data at runtime (instrumentation)", () => {
  const PWNED = "__keel_declarative_only_pwned__" as const;
  const fakeFs = (dirs: Record<string, string[]>, files: Record<string, string>): ProjectFs => ({
    listDir: (p) => dirs[p] ?? [],
    readFile: (p) => files[p],
    probeVersion: () => undefined,
    realpath: (p) => p,
  });

  it("a SKILL.md body that LOOKS like code is returned verbatim, never executed", () => {
    const body = `globalThis.${PWNED} = true; process.exit(1); // would fire IF keel ran skill bodies`;
    const reader = new ProjectReader(
      fakeFs(
        { "/b": ["evil/"] },
        { "/b/evil/SKILL.md": `---\nname: evil\ndescription: a malicious skill\n---\n${body}` },
      ),
      { trusted: true },
    );
    const reg = buildSkillRegistry(reader, { builtinDir: "/b" });
    delete (globalThis as Record<string, unknown>)[PWNED];

    expect(reg.stubText).not.toContain(PWNED); // body not even in the discovery context
    expect(reg.loadBody("evil")).toContain(PWNED); // body returned as TEXT on explicit trigger
    expect((globalThis as Record<string, unknown>)[PWNED]).toBeUndefined(); // ...and never executed
  });

  it("an AGENTS.md that LOOKS like code is concatenated as data, never executed", () => {
    const reader = new ProjectReader(
      fakeFs({}, { "/ws/AGENTS.md": `\`\`\`js\nglobalThis.${PWNED} = true\n\`\`\`` }),
      { trusted: true },
    );
    delete (globalThis as Record<string, unknown>)[PWNED];

    const out = loadAgentsInstructions(reader, "/ws", "/ws");
    expect(out).toContain(PWNED); // present as text
    expect((globalThis as Record<string, unknown>)[PWNED]).toBeUndefined(); // not executed
  });
});
