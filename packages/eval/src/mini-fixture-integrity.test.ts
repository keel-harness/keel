import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

describe("mini-eval fixture integrity", () => {
  it("retains nested build inputs while ignoring only the root packaging output", () => {
    const gitignore = readFileSync(join(repoRoot, ".gitignore"), "utf8");
    const nestedBuildInput = join(
      repoRoot,
      "eval/mini/tasks/05-fix-build-script/workspace/build/compile.js",
    );

    expect(gitignore).toMatch(/^\/build\/$/mu);
    expect(gitignore).not.toMatch(/^build\/$/mu);
    expect(existsSync(nestedBuildInput)).toBe(true);
  });
});
