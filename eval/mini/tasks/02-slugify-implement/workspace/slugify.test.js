const assert = require("node:assert");
const { slugify } = require("./slugify");

assert.strictEqual(slugify("Hello, World!"), "hello-world");
assert.strictEqual(slugify("a__b--c"), "a-b-c");
assert.strictEqual(slugify("!!!"), "");

console.log("All slugify tests passed.");
