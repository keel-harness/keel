// Held-out verifier: behavior must be identical after the rename, the old name fully gone, the new
// name present (so a partial rename that leaves a call site — and would crash — is caught).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import assert from "node:assert";

const out = execFileSync("node", ["main.js"], { encoding: "utf8" }).trim();
assert.strictEqual(out, "total=25\nwithTax=37.5", "behavior preserved after rename");

const src = ["cart.js", "pricing.js", "main.js"].map((f) => readFileSync(f, "utf8")).join("\n");
assert.ok(!/\bcalcTotal\b/.test(src), "old name `calcTotal` is fully removed");
assert.ok(/\bcomputeTotal\b/.test(src), "new name `computeTotal` is present");

console.log("rename verifier: behavior + full-rename checks passed");
