// Held-out verifier (the agent never sees this). Covers the spec's edge cases beyond the visible
// test — including escaped quotes — so a fix that only satisfies the visible test does not pass.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { parseCsvLine } = require("./csv.js");
const assert = (await import("node:assert")).default;

const cases = [
  ["a,b,c", ["a", "b", "c"]],
  ['a,"b,c",d', ["a", "b,c", "d"]],
  ["", [""]],
  ['"hello, world",ok', ["hello, world", "ok"]],
  ['x,"",y', ["x", "", "y"]],
  ['"she said ""hi""",done', ['she said "hi"', "done"]],
  ['"a,b","c,d"', ["a,b", "c,d"]],
];

for (const [input, expected] of cases) {
  assert.deepStrictEqual(parseCsvLine(input), expected, `parseCsvLine(${JSON.stringify(input)})`);
}
console.log(`csv verifier: ${cases.length} cases passed`);
