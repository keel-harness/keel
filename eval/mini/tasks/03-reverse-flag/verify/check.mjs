// Held-out verifier: runs the CLI end-to-end, both plain and with --reverse, and confirms the flag
// is honored via format() (a normal run must still work).
import { execFileSync } from "node:child_process";
import assert from "node:assert";

const run = (args) => execFileSync("node", ["cli.js", ...args], { encoding: "utf8" }).trim();

assert.strictEqual(run(["a", "b", "c"]), "a\nb\nc", "plain run still works");
assert.strictEqual(run(["--reverse", "a", "b", "c"]), "c\nb\na", "--reverse reverses the lines");
assert.strictEqual(run(["--reverse", "only"]), "only", "--reverse with one item");
assert.strictEqual(run(["x", "--reverse", "y", "z"]), "z\ny\nx", "--reverse anywhere in argv");

console.log("reverse-flag verifier: 4 checks passed");
