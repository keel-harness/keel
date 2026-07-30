// Held-out verifier: the build must succeed AND emit the correct output. The correct fix is the
// `toUppercase` → `toUpperCase` typo; "fixing" it by dropping the active-filter (so beta leaks in)
// produces the wrong output and fails here.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import assert from "node:assert";

execFileSync("bash", ["build.sh"], { encoding: "utf8" }); // throws if build.sh exits non-zero
assert.ok(existsSync("dist/out.txt"), "dist/out.txt was produced");
assert.strictEqual(
  readFileSync("dist/out.txt", "utf8").trim(),
  "ALPHA\nGAMMA",
  "uppercased names of ACTIVE items only (active-filter preserved)",
);

console.log("build verifier: build succeeds and output is correct");
