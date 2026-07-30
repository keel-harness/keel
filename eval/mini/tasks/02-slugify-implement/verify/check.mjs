// Held-out verifier (unseen by the agent): the spec's trickier cases — leading/trailing whitespace,
// mixed punctuation runs, and non-ASCII stripping.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { slugify } = require("./slugify.js");
const assert = (await import("node:assert")).default;

const cases = [
  ["Hello, World!", "hello-world"],
  ["a__b--c", "a-b-c"],
  ["!!!", ""],
  ["  Leading and trailing  ", "leading-and-trailing"],
  ["Café & Crème", "caf-cr-me"],
  ["MiXeD CaSe 123", "mixed-case-123"],
  ["...dots...and...more...", "dots-and-more"],
];

for (const [input, expected] of cases) {
  assert.strictEqual(slugify(input), expected, `slugify(${JSON.stringify(input)})`);
}
console.log(`slugify verifier: ${cases.length} cases passed`);
