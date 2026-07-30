import { describe, expect, it } from "vitest";
import { estimateTokens } from "./system-prompt.js";
import { type SnapshotDeps, environmentSnapshot } from "./environment.js";

/** Build deps from a flat fixture: dir names end in "/"; `versions` maps a tool → its --version line. */
function deps(entries: string[], versions: Record<string, string> = {}): SnapshotDeps {
  return {
    listDir: () => entries,
    probeVersion: (tool) => versions[tool],
    cores: 8,
    memGB: 16,
  };
}

describe("environmentSnapshot (§7 Epic 1.6 — bootstrapping, ~600-token cap)", () => {
  it("a Node/pnpm workspace: reports the cwd, toolchain version, package manager, files, system", () => {
    const snap = environmentSnapshot(
      "/work/app",
      deps(["src/", "package.json", "pnpm-lock.yaml", "tsconfig.json", "README.md"], {
        node: "v20.20.1",
      }),
    );
    expect(snap).toMatch(/cwd:.*\/work\/app/);
    expect(snap).toMatch(/node v20\.20\.1/);
    expect(snap).toMatch(/pnpm/); // package manager inferred from pnpm-lock.yaml
    expect(snap).toMatch(/package\.json/); // files listed
    expect(snap).toMatch(/8 cores/);
    expect(snap).toMatch(/16 ?GB/);
  });

  it("a polyglot workspace surfaces every detected toolchain + package manager", () => {
    const snap = environmentSnapshot(
      "/poly",
      deps(["package.json", "Cargo.toml", "go.mod", "requirements.txt", "src/"], {
        node: "v20.20.1",
        python3: "Python 3.12.1",
        go: "go version go1.22",
        cargo: "cargo 1.77.0",
      }),
    );
    for (const t of ["node", "python3", "go", "cargo"]) expect(snap).toMatch(new RegExp(t));
    for (const pm of ["npm", "cargo", "go", "pip"]) expect(snap).toMatch(new RegExp(pm));
  });

  it("filters universal noise (node_modules, .git, .DS_Store) from the file listing", () => {
    const snap = environmentSnapshot(
      "/work",
      deps([".git/", "node_modules/", ".DS_Store", "src/", "package.json"], { node: "v20" }),
    );
    expect(snap).toMatch(/src\//);
    expect(snap).toMatch(/package\.json/);
    expect(snap).not.toMatch(/node_modules/);
    expect(snap).not.toMatch(/\.git\//);
    expect(snap).not.toMatch(/\.DS_Store/);
  });

  it("an empty workspace is honest (no toolchains/files) and tiny", () => {
    const snap = environmentSnapshot("/empty", deps([], {}));
    expect(snap).toMatch(/cwd:.*\/empty/);
    expect(snap).toMatch(/none|—/); // honest "no toolchains detected"
    expect(estimateTokens(snap)).toBeLessThan(100);
  });

  it("stays within the ~600-token cap and NEVER truncates the toolchain list (only files)", () => {
    const manyFiles = Array.from({ length: 400 }, (_, i) => `file_${i}_with_a_longish_name.ts`);
    const snap = environmentSnapshot(
      "/big",
      deps(manyFiles, { node: "v20.20.1", python3: "Python 3.12.1", go: "go1.22", cargo: "1.77" }),
    );
    expect(estimateTokens(snap)).toBeLessThanOrEqual(600);
    // all four toolchains survive even though the file list must be truncated
    for (const t of ["node", "python3", "go", "cargo"]) expect(snap).toMatch(new RegExp(t));
    expect(snap).toMatch(/\+\d+ more/); // files truncated with a count, not silently dropped
  });
});
