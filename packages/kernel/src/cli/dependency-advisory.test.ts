import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const requireFromTest = createRequire(import.meta.url);
const viteManifest = requireFromTest.resolve("vite/package.json");
const requireFromVite = createRequire(viteManifest);
const postcssManifest = requireFromVite.resolve("postcss/package.json");
const requireFromPostcss = createRequire(postcssManifest);
const nanoidEntry = pathToFileURL(requireFromPostcss.resolve("nanoid")).href;

function runZeroSizeProbe(factory: "customAlphabet" | "customRandom") {
  const expression =
    factory === "customAlphabet"
      ? "customAlphabet('ab', 0)()"
      : "customRandom('ab', 0, () => new Uint8Array())()";

  return spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `const { ${factory} } = await import(${JSON.stringify(nanoidEntry)}); process.stdout.write(JSON.stringify(${expression}));`,
    ],
    { encoding: "utf8", timeout: 1_000 },
  );
}

describe("dependency advisory regressions", () => {
  it.each(["customAlphabet", "customRandom"] as const)(
    "nanoid %s terminates for a zero-size identifier",
    (factory) => {
      const probe = runZeroSizeProbe(factory);

      expect(probe.error).toBeUndefined();
      expect(probe.status).toBe(0);
      expect(probe.stderr).toBe("");
      expect(probe.stdout).toBe('""');
    },
  );
});
