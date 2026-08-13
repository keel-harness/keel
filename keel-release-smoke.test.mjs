import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

test("keel-release-smoke.md contains RELEASE_SMOKE_V012_42119BA", () => {
  const md = readFileSync(join(__dirname, "keel-release-smoke.md"), "utf8");
  assert.ok(
    md.includes("RELEASE_SMOKE_V012_42119BA"),
    "marker RELEASE_SMOKE_V012_42119BA not found in keel-release-smoke.md",
  );
});
