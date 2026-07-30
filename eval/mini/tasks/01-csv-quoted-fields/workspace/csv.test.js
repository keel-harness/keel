const assert = require("node:assert");
const { parseCsvLine } = require("./csv");

assert.deepStrictEqual(parseCsvLine("a,b,c"), ["a", "b", "c"], "plain fields");
assert.deepStrictEqual(parseCsvLine('a,"b,c",d'), ["a", "b,c", "d"], "quoted field with a comma");
assert.deepStrictEqual(parseCsvLine(""), [""], "empty line");

console.log("All csv tests passed.");
