// Post-build copy of the committed TB-2 data JSON into dist.
//
// `tb2/subsets.ts` reads `catalog.json` + the task lists at runtime relative to its own module
// (`new URL('./<file>', import.meta.url)`), but `tsc` does NOT copy `.json` files — so a consumer of the
// BUILT package (`dist/`) would hit `ENOENT` and the fail-closed `assertSubsetIntegrity` pre-spend gate
// would crash instead of validating. This copies every `src/tb2/*.json` next to the emitted JS so the
// built loader works exactly like the source one. (The test fixtures under `src/fixtures/` are read only
// by `*.test.ts`, which never build, so they are deliberately not copied.)
import { cp, mkdir, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(pkgRoot, "src", "tb2");
const distDir = join(pkgRoot, "dist", "tb2");

await mkdir(distDir, { recursive: true });
let copied = 0;
for (const entry of await readdir(srcDir)) {
  if (entry.endsWith(".json")) {
    await cp(join(srcDir, entry), join(distDir, entry));
    copied += 1;
  }
}
// Throw (fail the build) rather than emitting a dist with no data — a build script that throws exits
// non-zero, and this avoids needing the `console`/`process` node globals in this lightweight .mjs.
if (copied === 0) {
  throw new Error(
    "copy-tb2-data: no JSON data files in src/tb2 — the built subset loader would ENOENT",
  );
}
