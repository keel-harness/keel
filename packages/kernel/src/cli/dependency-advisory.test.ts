import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const requireFromTest = createRequire(import.meta.url);
const viteManifest = requireFromTest.resolve("vite/package.json");
const requireFromVite = createRequire(viteManifest);
const postcssManifest = requireFromVite.resolve("postcss/package.json");
const requireFromPostcss = createRequire(postcssManifest);
const nanoidEntryPath = requireFromPostcss.resolve("nanoid");
const nanoidEntry = pathToFileURL(nanoidEntryPath).href;
const nanoidNativeEntry = pathToFileURL(
  join(dirname(nanoidEntryPath), "async/index.native.js"),
).href;

const expoRandomStub = `data:text/javascript,${encodeURIComponent(
  "export async function getRandomBytesAsync(size) { return new Uint8Array(size); }",
)}`;
const expoRandomLoader = `data:text/javascript,${encodeURIComponent(`
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === "expo-random") {
      return { url: ${JSON.stringify(expoRandomStub)}, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  }
`)}`;

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

function runNativeAsyncZeroSizeProbe() {
  return spawnSync(
    process.execPath,
    [
      "--no-warnings",
      "--experimental-loader",
      expoRandomLoader,
      "--input-type=module",
      "--eval",
      `const { customAlphabet } = await import(${JSON.stringify(nanoidNativeEntry)}); process.stdout.write(JSON.stringify(await customAlphabet("ab", 0)()));`,
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

  it("nanoid React Native async customAlphabet terminates for a zero-size identifier", () => {
    const probe = runNativeAsyncZeroSizeProbe();

    expect(probe.error).toBeUndefined();
    expect(probe.status).toBe(0);
    expect(probe.stderr).toBe("");
    expect(probe.stdout).toBe('""');
  });
});
