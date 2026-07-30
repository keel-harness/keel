import { describe, expect, it } from "vitest";
import {
  escapeSearchGlobLiteral,
  formatSearchResultPath,
  isVisibleSearchPath,
  matchesVisibleSearchGlob,
  normalizeSearchPath,
  searchExecutionScopeFromGlob,
} from "./search-path.js";

describe("model-visible search path filtering", () => {
  it("excludes hidden paths even when a glob would otherwise match them", () => {
    expect(isVisibleSearchPath("")).toBe(false);
    expect(isVisibleSearchPath("/abs/path.txt")).toBe(false);
    expect(isVisibleSearchPath("../escape.txt")).toBe(false);
    expect(isVisibleSearchPath(".env")).toBe(false);
    expect(isVisibleSearchPath("packages/.DS_Store")).toBe(false);
    expect(isVisibleSearchPath("src/.cache/file.txt")).toBe(false);
    expect(matchesVisibleSearchGlob(".env", ".env")).toBe(false);
    expect(matchesVisibleSearchGlob("packages/.DS_Store", "packages/**")).toBe(false);
  });

  it("matches ripgrep-style positive and negative globs over visible paths", () => {
    expect(matchesVisibleSearchGlob("src/a.ts", "*.ts")).toBe(true);
    expect(matchesVisibleSearchGlob("src/a.ts", "src/*.ts")).toBe(true);
    expect(matchesVisibleSearchGlob("src/nested/a.ts", "src/*.ts")).toBe(false);
    expect(matchesVisibleSearchGlob("README.md", "README.md")).toBe(true);
    expect(matchesVisibleSearchGlob("docs/README.md", "README.md")).toBe(false);
    expect(matchesVisibleSearchGlob("packages/eval/src/index.ts", "packages/**")).toBe(true);
    expect(matchesVisibleSearchGlob("dist/index.js", "!dist/**")).toBe(false);
    expect(matchesVisibleSearchGlob("src/index.ts", "!dist/**")).toBe(true);
  });

  it("normalizes ripgrep result paths before display and filtering", () => {
    expect(normalizeSearchPath("./src/a.txt")).toBe("src/a.txt");
    expect(normalizeSearchPath("src//nested/a.txt")).toBe("src/nested/a.txt");
    expect(normalizeSearchPath("src\\nested\\a.txt")).toBe("src/nested/a.txt");
  });

  it("derives only concrete visible execution scopes from content globs", () => {
    expect(searchExecutionScopeFromGlob("src/**")).toBe("src");
    expect(searchExecutionScopeFromGlob("src/*.ts")).toBe("src");
    expect(searchExecutionScopeFromGlob("src/deep/**/*.ts")).toBe("src/deep");
    expect(searchExecutionScopeFromGlob("README.md")).toBe("README.md");
    expect(searchExecutionScopeFromGlob(String.raw`src/a\*b.txt`)).toBe("src/a*b.txt");
    expect(searchExecutionScopeFromGlob("*.ts")).toBeUndefined();
    expect(searchExecutionScopeFromGlob("**")).toBeUndefined();
    expect(searchExecutionScopeFromGlob("src{1,2}/**")).toBeUndefined();
    expect(searchExecutionScopeFromGlob("!dist/**")).toBeUndefined();
    expect(searchExecutionScopeFromGlob(".env")).toBeUndefined();
    expect(searchExecutionScopeFromGlob("../outside/**")).toBeUndefined();
  });

  it("honors escaped glob metacharacters for path aliases normalized to literal globs", () => {
    expect(matchesVisibleSearchGlob("a*b.txt", String.raw`a\*b.txt`)).toBe(true);
    expect(matchesVisibleSearchGlob("docs/a*b.txt", String.raw`a\*b.txt`)).toBe(false);
    expect(matchesVisibleSearchGlob("ab.txt", String.raw`a\*b.txt`)).toBe(false);
    expect(matchesVisibleSearchGlob("src/a*b.txt", String.raw`src/a\*b.txt`)).toBe(true);
    expect(matchesVisibleSearchGlob("src/ab.txt", String.raw`src/a\*b.txt`)).toBe(false);
    expect(matchesVisibleSearchGlob("src/name[old].txt", String.raw`src/name\[old\].txt`)).toBe(
      true,
    );
    expect(matchesVisibleSearchGlob("src/nameo.txt", String.raw`src/name\[old\].txt`)).toBe(false);
  });

  it("escapes picomatch extglob metacharacters for literal path aliases", () => {
    const escaped = escapeSearchGlobLiteral("src/a+(b)@c|d.txt");

    expect(matchesVisibleSearchGlob("src/a+(b)@c|d.txt", escaped)).toBe(true);
    expect(matchesVisibleSearchGlob("src/abc|d.txt", escaped)).toBe(false);
    expect(matchesVisibleSearchGlob("src/a+c|d.txt", escaped)).toBe(false);
  });

  it("keeps ordinary result paths plain and quotes control-bearing paths", () => {
    expect(formatSearchResultPath("src/a.txt")).toBe("src/a.txt");
    expect(formatSearchResultPath("src/name with spaces.txt")).toBe("src/name with spaces.txt");
    expect(formatSearchResultPath("src/evil\nfake.txt")).toBe('"src/evil\\nfake.txt"');
    expect(formatSearchResultPath("src/evil\rname.txt")).toBe('"src/evil\\rname.txt"');
    expect(formatSearchResultPath("src/evil\tname.txt")).toBe('"src/evil\\tname.txt"');
    expect(formatSearchResultPath("src/evil\bname.txt")).toBe('"src/evil\\bname.txt"');
    expect(formatSearchResultPath("src/evil\fname.txt")).toBe('"src/evil\\fname.txt"');
    expect(formatSearchResultPath("src/\u001b[31mred.txt")).toBe('"src/\\u001b[31mred.txt"');
    expect(formatSearchResultPath('src/"quoted"\nname.txt')).toBe('"src/\\"quoted\\"\\nname.txt"');
    expect(formatSearchResultPath("src/back\\slash\nname.txt")).toBe(
      '"src/back\\\\slash\\nname.txt"',
    );
  });
});
