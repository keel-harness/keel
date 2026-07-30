import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Guard the `pnpm keel` dev runner against the "React is not defined" crash class.
 *
 * The Ink components rely on React's AUTOMATIC JSX runtime (no `import React`). tsc (build) and vitest
 * get that from tsconfig `jsx:"react-jsx"` / the esbuild config — but `tsx` (what `pnpm keel` runs)
 * does NOT apply tsconfig's `jsx`, so without a per-file `@jsxRuntime automatic` pragma it transpiles
 * JSX to classic `React.createElement` and crashes at launch. A new Ink `.tsx` that forgets the pragma
 * would break the interactive TUI while the `pnpm keel --version` CI smoke (which never mounts Ink)
 * stays green — so enforce the pragma here, cheaply and deterministically, instead of relying on a
 * comment plea. If you intentionally remove the pragma, this test should change with a written reason.
 */
describe("Ink .tsx JSX-runtime pragma (pnpm keel dev-runner compat)", () => {
  const inkTsx = readdirSync(here).filter((f) => f.endsWith(".tsx") && !f.endsWith(".test.tsx"));

  it("there is at least one Ink component file to guard (the glob isn't silently empty)", () => {
    expect(inkTsx.length).toBeGreaterThan(0);
  });

  it.each(inkTsx)("%s declares the automatic JSX runtime pragma", (file) => {
    const src = readFileSync(join(here, file), "utf8");
    // esbuild reads this from a comment; assert both halves so the runtime is unambiguous under tsx.
    expect(src).toContain("@jsxRuntime automatic");
    expect(src).toContain("@jsxImportSource react");
  });
});
